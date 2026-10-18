import { SELF } from 'cloudflare:test'
import { createControlFrame, PROTOCOL_VERSION } from '@dsh-remote/protocol'
import { describe, expect, it } from 'vitest'

const account = 'owner@example.com'
const password = 'local-cloudflare-test-password'
const base = 'https://example.com'

// Canonical 32-byte X25519 public keys, base64url without padding.
const hostIdentityKey = 'A'.repeat(43)
const clientIdentityKey = `${'E'.repeat(42)}A`
let keyCounter = 0
function nextIdentityKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const prefix = alphabet[keyCounter++ % alphabet.length]!
  return `${prefix}${'A'.repeat(41)}A`
}

interface Wire {
  ws: WebSocket
  send(type: string, payload: unknown): void
  next(type: string, timeout?: number): Promise<any>
}

async function request(path: string, method = 'GET', body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await SELF.fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data: any
  try { data = await response.json() } catch { data = undefined }
  return { status: response.status, data, headers: response.headers }
}

async function loginToken(): Promise<string> {
  const login = await request('/auth/login', 'POST', { email: account, password })
  expect(login.status).toBe(200)
  return login.data.token
}

async function register(token: string, role: 'host' | 'client') {
  const descriptor = {
    deviceId: crypto.randomUUID(),
    name: `test-${role}`,
    role,
    platform: 'linux',
    identityKey: role === 'host' ? hostIdentityKey : clientIdentityKey,
    clientVersion: '0.5.12',
  }
  const result = await request('/devices/register', 'POST', { v: PROTOCOL_VERSION, device: descriptor }, token)
  expect(result.status).toBe(200)
  return { ...descriptor, ...result.data as { accessToken: string; refreshToken: string } }
}

function wireOf(ws: WebSocket): Wire {
  const messages: any[] = []
  const waiters: Array<() => void> = []
  ws.addEventListener('message', event => {
    messages.push(JSON.parse(String(event.data)))
    for (const notify of waiters.splice(0)) notify()
  })
  return {
    ws,
    send(type, payload) { ws.send(JSON.stringify(createControlFrame(type, payload))) },
    async next(type, timeout = 5000) {
      const until = Date.now() + timeout
      while (Date.now() < until) {
        const index = messages.findIndex(message => message.type === type)
        if (index >= 0) return messages.splice(index, 1)[0].payload
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 25)
          waiters.push(() => { clearTimeout(timer); resolve() })
        })
      }
      throw new Error(`timed out waiting for ${type}; have ${JSON.stringify(messages.map(message => message.type))}`)
    },
  }
}

async function openSocket(device: Awaited<ReturnType<typeof register>>, overrides: Record<string, unknown> = {}): Promise<Wire> {
  const response = await SELF.fetch(`${base}/ws/v1/connect`, { headers: { Upgrade: 'websocket' } })
  expect(response.status).toBe(101)
  const ws = response.webSocket as WebSocket | null
  expect(ws).not.toBeNull()
  ws!.accept()
  const wire = wireOf(ws!)
  wire.send('hello', {
    role: device.role,
    deviceId: device.deviceId,
    accessToken: device.accessToken,
    protocols: [PROTOCOL_VERSION],
    capabilities: ['transport.relay', 'transport.p2p'],
    clientVersion: device.clientVersion,
    ...overrides,
  })
  return wire
}

async function closeCode(ws: WebSocket): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), 5000)
    ws.addEventListener('close', event => { clearTimeout(timer); resolve((event as CloseEvent).code) }, { once: true })
  })
}

describe('self-hosted Cloudflare server', () => {
  it('authorizes account and device credentials and enforces membership rules', async () => {
    expect((await request('/auth/login', 'POST', { email: account, password: 'wrong-password-123' })).status).toBe(401)
    expect((await request('/auth/login', 'POST', { email: account, password }, undefined)).status).toBe(200)

    const login = await request('/auth/login', 'POST', { email: account, password })
    const setCookie = login.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0]!
    expect(setCookie).toContain('HttpOnly')
    expect((await request('/auth/me', 'GET', undefined, undefined)).status).toBe(401)
    const viaCookie = await SELF.fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: cookie } })
    expect(viaCookie.status).toBe(200)

    const accountToken = login.data.token as string
    expect((await request('/devices', 'GET', undefined, accountToken)).status).toBe(401)

    const host = await register(accountToken, 'host')
    const client = await register(accountToken, 'client')
    expect((await request('/me', 'GET', undefined, accountToken)).status).toBe(401)

    const list = await request('/devices', 'GET', undefined, client.accessToken)
    expect(list.status).toBe(200)
    expect(list.data.items.some((item: any) => item.deviceId === host.deviceId)).toBe(true)
    expect(list.data.items.every((item: any) => item.identityKey === undefined)).toBe(true)
    expect((await request('/devices', 'GET', undefined, host.accessToken)).status).toBe(403)

    const presence = await request(`/devices/${encodeURIComponent(host.deviceId)}/presence`, 'GET', undefined, client.accessToken)
    expect(presence.status).toBe(200)
    expect(presence.data.online).toBe(false)

    const mismatch = await request('/devices/register', 'POST', {
      v: PROTOCOL_VERSION,
      device: {
        deviceId: host.deviceId,
        name: host.name,
        role: host.role,
        platform: host.platform,
        identityKey: client.identityKey,
        clientVersion: host.clientVersion,
      },
    }, accountToken)
    expect(mismatch.status).toBe(409)
    expect(mismatch.data.error.code).toBe('PEER_IDENTITY_MISMATCH')
  })

  it('relays the control lifecycle and rejects replayed relay counters', async () => {
    const accountToken = await loginToken()
    const host = await register(accountToken, 'host')
    const client = await register(accountToken, 'client')
    const hostWire = await openSocket(host)
    expect(await hostWire.next('hello.ack')).toMatchObject({ webrtcEnabled: false, capabilities: ['transport.relay'] })
    const clientWire = await openSocket(client)
    await clientWire.next('hello.ack')

    clientWire.send('connect.request', { hostDeviceId: host.deviceId, preferredTransports: ['relay'] })
    const incoming = await hostWire.next('connect.incoming')
    expect(incoming.clientDeviceId).toBe(client.deviceId)
    expect(incoming.clientIdentityKey).toBe(client.identityKey)
    hostWire.send('connect.accepted', { connectionId: incoming.connectionId })
    const accepted = await clientWire.next('connect.accepted')
    expect(accepted.connectionId).toBe(incoming.connectionId)
    const connectionId = incoming.connectionId as string

    clientWire.send('transport.selected', { connectionId, targetDeviceId: host.deviceId, transport: 'relay' })
    await hostWire.next('transport.selected')
    clientWire.send('secure.handshake', { connectionId, targetDeviceId: host.deviceId, step: 1, data: 'AQID' })
    await hostWire.next('secure.handshake')
    hostWire.send('secure.handshake', { connectionId, targetDeviceId: client.deviceId, step: 2, data: 'BAUG' })
    await clientWire.next('secure.handshake')

    clientWire.send('relay', { connectionId, targetDeviceId: host.deviceId, counter: 0, ciphertext: 'AQIDBA' })
    expect((await hostWire.next('relay')).ciphertext).toBe('AQIDBA')
    clientWire.send('relay', { connectionId, targetDeviceId: host.deviceId, counter: 0, ciphertext: 'AQIDBA' })
    expect((await clientWire.next('error')).code).toBe('INVALID_MESSAGE')
    clientWire.send('ping', { nonce: 'still-open' })
    expect(await clientWire.next('pong')).toEqual({ nonce: 'still-open' })

    // Revocation closes the live socket and invalidates its token.
    const closed = closeCode(clientWire.ws)
    expect((await request('/devices/self', 'DELETE', undefined, client.accessToken)).status).toBe(200)
    expect(await closed).toBe(4001)
    expect((await request('/me', 'GET', undefined, client.accessToken)).status).toBe(401)
    expect((await hostWire.next('error')).connectionId).toBe(connectionId)
  })

  it('rotates refresh tokens and revokes a reused token family', async () => {
    const accountToken = await loginToken()
    const device = await register(accountToken, 'client')
    const rotated = await request('/auth/refresh', 'POST', { deviceId: device.deviceId, refreshToken: device.refreshToken })
    expect(rotated.status).toBe(200)
    expect(rotated.data.refreshToken).not.toBe(device.refreshToken)
    const reuse = await request('/auth/refresh', 'POST', { deviceId: device.deviceId, refreshToken: device.refreshToken })
    expect(reuse.status).toBe(401)
    expect((await request('/me', 'GET', undefined, rotated.data.accessToken)).status).toBe(401)
  })
})
