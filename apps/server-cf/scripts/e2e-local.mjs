#!/usr/bin/env node
/**
 * Local end-to-end check for apps/server-cf against a running `wrangler dev`.
 *
 * Covers: health/static routes, account login + cookie, device registration and
 * pinning, device discovery/presence, Control WebSocket hello, connect lifecycle,
 * Noise IK handshake relay, encrypted relay frames, replay rejection, and
 * revocation closing the live socket.
 *
 * Usage (with `wrangler dev` listening on 127.0.0.1:8787):
 *   DSH_CF_ACCOUNT=owner@example.com DSH_CF_PASSWORD=... \
 *     node apps/server-cf/scripts/e2e-local.mjs
 */
import WebSocket from 'ws'
import {
  PROTOCOL_VERSION,
  createControlFrame,
  MAX_CONTROL_FRAME_BYTES,
} from '../../../packages/protocol/dist/index.js'
import {
  NoiseIkSession,
  createNoisePrologue,
  fromBase64Url,
  generateKeyPair,
  toBase64Url,
} from '../../../packages/crypto/dist/index.js'

const base = (process.env.DSH_CF_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/u, '')
const wsBase = base.replace(/^http/u, 'ws')
const account = process.env.DSH_CF_ACCOUNT
const password = process.env.DSH_CF_PASSWORD
if (!account || !password) throw new Error('DSH_CF_ACCOUNT and DSH_CF_PASSWORD are required')

const failures = []
const sockets = []
function check(condition, label, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures.push(label)
    console.error(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
  return condition
}

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data
  try { data = await response.json() } catch { data = undefined }
  return { status: response.status, data, headers: response.headers }
}

class Wire {
  constructor(ws) {
    this.ws = ws
    this.messages = []
    this.waiters = []
    ws.on('message', raw => {
      try { this.messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
      for (const notify of this.waiters.splice(0)) notify()
    })
  }
  send(type, payload) { this.ws.send(JSON.stringify(createControlFrame(type, payload))) }
  async next(type, timeout = 5000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const index = this.messages.findIndex(message => message.type === type)
      if (index >= 0) return this.messages.splice(index, 1)[0].payload
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 50)
        this.waiters.push(() => { clearTimeout(timer); resolve() })
      })
    }
    throw new Error(`Timed out waiting for frame ${type}; have ${JSON.stringify(this.messages.map(m => m.type))}`)
  }
}

async function openSocket(device, overrides = {}) {
  const ws = new WebSocket(`${wsBase}/ws/v1/connect`)
  sockets.push(ws)
  const wire = new Wire(ws)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  wire.send('hello', {
    role: device.role,
    deviceId: device.deviceId,
    accessToken: device.accessToken,
    protocols: [PROTOCOL_VERSION],
    capabilities: ['transport.relay', 'transport.p2p'],
    clientVersion: '0.5.12',
    ...overrides,
  })
  return wire
}

async function waitClose(ws, timeout = 5000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeout)
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }) })
  })
}

async function device(accountToken, role) {
  const keys = generateKeyPair()
  const descriptor = {
    deviceId: crypto.randomUUID(),
    identityKey: keys.publicKey,
    name: `cf-${role}-${Date.now()}`,
    role,
    platform: 'linux',
    clientVersion: '0.5.12',
  }
  const result = await request('/devices/register', 'POST', { v: PROTOCOL_VERSION, device: descriptor }, { Authorization: `Bearer ${accountToken}` })
  if (result.status !== 200) throw new Error(`register ${role} failed: ${result.status} ${JSON.stringify(result.data)}`)
  return { ...descriptor, keys, ...result.data }
}

async function main() {
  console.log(`e2e against ${base}`)

  // ---- static / health -----------------------------------------------------
  const health = await fetch(`${base}/health`)
  check(health.status === 200 && (await health.json()).status === 'ok', 'health endpoint')

  const index = await fetch(`${base}/`)
  const indexBody = await index.text()
  check(index.status === 200 && (index.headers.get('content-type') ?? '').includes('text/html'), 'root serves HTML', index.status)
  check(indexBody.includes('<div id="root"') || indexBody.includes('<script'), 'root serves the built Web UI')

  const loginRoute = await fetch(`${base}/app/login`)
  check(loginRoute.status === 200, '/app/login serves the Web UI', loginRoute.status)

  const unknown = await request('/devices/does-not-exist', 'GET')
  check(unknown.status === 401, 'missing device auth is rejected before routing', unknown.status)

  const assetMiss = await fetch(`${base}/assets/definitely-missing.js`)
  check(assetMiss.status === 404, 'missing asset is 404', assetMiss.status)

  // ---- account auth -------------------------------------------------------
  const badLogin = await request('/auth/login', 'POST', { email: account, password: `${password}-wrong` })
  check(badLogin.status === 401 && badLogin.data?.error?.code === 'AUTH_INVALID', 'wrong password rejected', badLogin.status)

  const crossOrigin = await request('/auth/login', 'POST', { email: account, password }, { Origin: 'https://attacker.example' })
  check(crossOrigin.status === 403, 'cross-origin request rejected', crossOrigin.status)

  const login = await request('/auth/login', 'POST', { email: account, password })
  check(login.status === 200 && typeof login.data?.token === 'string', 'account login returns token', login.status)
  const setCookie = login.headers.get('set-cookie') ?? ''
  check(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), 'login sets HttpOnly SameSite cookie', setCookie)
  const cookie = setCookie.split(';')[0]
  const accountToken = login.data.token

  const me = await request('/auth/me', 'GET', undefined, { Authorization: `Bearer ${accountToken}` })
  check(me.status === 200 && me.data?.account === account, 'account /auth/me', me.status)
  const meCookie = await request('/auth/me', 'GET', undefined, { Cookie: cookie })
  check(meCookie.status === 200, 'account /auth/me via cookie', meCookie.status)

  // ---- device registration ------------------------------------------------
  const host = await device(accountToken, 'host')
  const client = await device(accountToken, 'client')
  check(Boolean(host.accessToken && host.refreshToken), 'host registered with token pair')

  const mismatchedDescriptor = {
    deviceId: host.deviceId,
    name: host.name,
    role: host.role,
    platform: host.platform,
    clientVersion: host.clientVersion,
    identityKey: client.identityKey,
  }
  const mismatched = await request('/devices/register', 'POST', {
    v: PROTOCOL_VERSION,
    device: mismatchedDescriptor,
  }, { Authorization: `Bearer ${accountToken}` })
  check(mismatched.status === 409 && mismatched.data?.error?.code === 'PEER_IDENTITY_MISMATCH', 'identity pinning enforced', mismatched.status)

  const accountMe = await request('/me', 'GET', undefined, { Authorization: `Bearer ${accountToken}` })
  check(accountMe.status === 401, 'account token cannot call device endpoints', accountMe.status)

  const hostList = await request('/devices', 'GET', undefined, { Authorization: `Bearer ${client.accessToken}` })
  check(hostList.status === 200 && hostList.data.items.some(item => item.deviceId === host.deviceId), 'client lists host devices', hostList.status)
  check(hostList.data.items.every(item => item.identityKey === undefined), 'device list omits identity keys')

  const hostAsClient = await request('/devices', 'GET', undefined, { Authorization: `Bearer ${host.accessToken}` })
  check(hostAsClient.status === 403, 'host role cannot list hosts', hostAsClient.status)

  const presenceOffline = await request(`/devices/${encodeURIComponent(host.deviceId)}/presence`, 'GET', undefined, { Authorization: `Bearer ${client.accessToken}` })
  check(presenceOffline.status === 200 && presenceOffline.data.online === false, 'presence is offline before hello', presenceOffline.data)

  // ---- Control hello ------------------------------------------------------
  const hostWire = await openSocket(host, { harnessVersion: '0.2.1-rc.1' })
  const hostAck = await hostWire.next('hello.ack')
  check(hostAck?.protocol === PROTOCOL_VERSION && hostAck?.webrtcEnabled === false, 'host hello.ack relay-only', hostAck)
  check(Array.isArray(hostAck?.capabilities) && hostAck.capabilities.join(',') === 'transport.relay', 'hello.ack capabilities are the relay intersection', hostAck?.capabilities)
  check(hostAck?.heartbeatIntervalMs === 25_000 && hostAck?.maxControlFrameBytes === MAX_CONTROL_FRAME_BYTES, 'hello.ack advertises heartbeat/limits', hostAck)

  const clientWire = await openSocket(client)
  await clientWire.next('hello.ack')

  const presenceOnline = await request(`/devices/${encodeURIComponent(host.deviceId)}/presence`, 'GET', undefined, { Authorization: `Bearer ${client.accessToken}` })
  check(presenceOnline.status === 200 && presenceOnline.data.online === true, 'presence is online after hello', presenceOnline.data)

  // ---- connect lifecycle --------------------------------------------------
  clientWire.send('connect.request', { hostDeviceId: host.deviceId, preferredTransports: ['relay'] })
  const incoming = await hostWire.next('connect.incoming')
  check(incoming?.clientDeviceId === client.deviceId && incoming?.clientIdentityKey === client.identityKey, 'connect.incoming carries authorized client identity', { incoming, expected: client.identityKey })
  hostWire.send('connect.accepted', { connectionId: incoming.connectionId })
  const accepted = await clientWire.next('connect.accepted')
  check(accepted?.connectionId === incoming.connectionId, 'connect.accepted reaches the client')
  const connectionId = incoming.connectionId

  // ---- Noise IK handshake relay ------------------------------------------
  const prologue = createNoisePrologue(connectionId, host.deviceId, client.deviceId)
  const initiator = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: client.keys.privateKey,
    localPublicKey: client.identityKey,
    remotePublicKey: host.identityKey,
    prologue,
  })
  const responder = new NoiseIkSession({
    role: 'responder',
    localPrivateKey: host.keys.privateKey,
    localPublicKey: host.identityKey,
    remotePublicKey: client.identityKey,
    prologue,
  })
  clientWire.send('secure.handshake', {
    connectionId,
    targetDeviceId: host.deviceId,
    step: 1,
    data: toBase64Url(initiator.writeHandshake()),
  })
  const step1 = await hostWire.next('secure.handshake')
  responder.readHandshake(fromBase64Url(step1.data))
  hostWire.send('secure.handshake', {
    connectionId,
    targetDeviceId: client.deviceId,
    step: 2,
    data: toBase64Url(responder.writeHandshake()),
  })
  const step2 = await clientWire.next('secure.handshake')
  initiator.readHandshake(fromBase64Url(step2.data))
  check(initiator.complete && responder.complete, 'Noise IK handshake relayed through the DO')

  // ---- encrypted relay ----------------------------------------------------
  const requestCiphertext = initiator.encrypt(new TextEncoder().encode('whoami from cf e2e'))
  clientWire.send('relay', {
    connectionId,
    targetDeviceId: host.deviceId,
    counter: 0,
    ciphertext: toBase64Url(requestCiphertext),
  })
  const relayedRequest = await hostWire.next('relay')
  check(relayedRequest?.ciphertext === toBase64Url(requestCiphertext), 'relay frame is forwarded opaque (no re-encoding)')
  const requestPlaintext = new TextDecoder().decode(responder.decrypt(fromBase64Url(relayedRequest.ciphertext)))
  check(requestPlaintext === 'whoami from cf e2e', 'host decrypts the relayed request', requestPlaintext)

  const responseCiphertext = responder.encrypt(new TextEncoder().encode('pong from host'))
  hostWire.send('relay', {
    connectionId,
    targetDeviceId: client.deviceId,
    counter: 0,
    ciphertext: toBase64Url(responseCiphertext),
  })
  const relayedResponse = await clientWire.next('relay')
  const responsePlaintext = new TextDecoder().decode(initiator.decrypt(fromBase64Url(relayedResponse.ciphertext)))
  check(responsePlaintext === 'pong from host', 'client decrypts the relayed response', responsePlaintext)

  // ---- replay / scoped error ---------------------------------------------
  clientWire.send('relay', {
    connectionId,
    targetDeviceId: host.deviceId,
    counter: 0,
    ciphertext: toBase64Url(requestCiphertext),
  })
  const replayError = await clientWire.next('error')
  check(replayError?.code === 'INVALID_MESSAGE' && replayError?.connectionId === connectionId, 'duplicate relay counter is rejected with a scoped error', replayError)
  clientWire.send('ping', { nonce: 'still-alive' })
  const pong = await clientWire.next('pong')
  check(pong?.nonce === 'still-alive', 'scoped relay error does not close the Control socket')

  // ---- revocation closes the live socket ---------------------------------
  const clientClosed = waitClose(clientWire.ws)
  const revoke = await request('/devices/self', 'DELETE', undefined, { Authorization: `Bearer ${client.accessToken}` })
  check(revoke.status === 200 && revoke.data?.status === 'revoked', 'device can revoke itself', revoke.status)
  const closed = await clientClosed
  check(closed.code === 4001, 'revoked device socket is closed with 4001', closed)
  const hostError = await hostWire.next('error')
  check(hostError?.connectionId === connectionId, 'host receives a scoped error for the revoked link', hostError)

  const revokedMe = await request('/me', 'GET', undefined, { Authorization: `Bearer ${client.accessToken}` })
  check(revokedMe.status === 401, 'revoked device token is rejected', revokedMe.status)

  // ---- refresh rotation ---------------------------------------------------
  const refreshed = await request('/auth/refresh', 'POST', { deviceId: host.deviceId, refreshToken: host.refreshToken })
  check(refreshed.status === 200 && refreshed.data.refreshToken !== host.refreshToken, 'refresh token rotates', refreshed.status)
  const reused = await request('/auth/refresh', 'POST', { deviceId: host.deviceId, refreshToken: host.refreshToken })
  check(reused.status === 401, 'reused refresh token is rejected', reused.status)
  const afterReuse = await request('/me', 'GET', undefined, { Authorization: `Bearer ${refreshed.data.accessToken}` })
  check(afterReuse.status === 401, 'refresh reuse revokes the token family', afterReuse.status)

  // ---- logout -------------------------------------------------------------
  const logout = await request('/auth/logout', 'POST', {}, { Cookie: cookie })
  check(logout.status === 200, 'account logout', logout.status)
  const afterLogout = await request('/auth/me', 'GET', undefined, { Cookie: cookie })
  check(afterLogout.status === 401, 'logged-out cookie is rejected', afterLogout.status)
}

try {
  await main()
} catch (error) {
  failures.push(`uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  console.error(error)
} finally {
  for (const socket of sockets) {
    try { socket.terminate() } catch { /* ignore */ }
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nE2E PASS')
}
