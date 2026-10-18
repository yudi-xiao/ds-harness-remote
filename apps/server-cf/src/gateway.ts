import {
  createControlFrame,
  decodeControlFrame,
  deviceRefreshRequestSchema,
  deviceRegistrationRequestSchema,
  MAX_CONTROL_FRAME_BYTES,
  MAX_RELAY_FRAME_BYTES,
  type ConnectRequestPayload,
  type ControlFrame,
  type HelloPayload,
  type RelayPayload,
  type SecureHandshakePayload,
  type TransportSelectedPayload,
} from '@dsh-remote/protocol'
import { z } from 'zod'
import { ApiError, Store, equal, hash, type LinkRow, type SavedDevice } from './store.js'
import { readConfig, type ServerConfig, type ServerEnv } from './types.js'

type Role = 'host' | 'client'
type LinkStage = LinkRow['stage']

interface Peer {
  ws: WebSocket
  id: string
  role: Role
  capabilities: string[]
  version: string
  lastPong: number
  nonce?: string
}

interface SocketAttachment {
  acceptedAt: number
  deviceId?: string
  role?: Role
  capabilities?: string[]
  version?: string
  lastPong?: number
  nonce?: string
}

interface RateWindow { start: number; frames: number; bytes: number }

interface Link {
  id: string
  host: string
  client: string
  stage: LinkStage
  created: number
  counters: Map<string, number>
}

const loginSchema = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) }).strict()
const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_TIMEOUT_MS = 75_000
const HELLO_TIMEOUT_MS = 5_000
const PENDING_LINK_TIMEOUT_MS = 30_000
const MAX_SOCKETS = 256
const MAX_LINKS = 256
const MAX_FRAMES_PER_SECOND = 512
const MAX_BYTES_PER_SECOND = 16 * MAX_RELAY_FRAME_BYTES

function modernHost(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/u.exec(version)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major! > 0 || (minor! > 2 || (minor === 2 && patch! >= 15))
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) throw new ApiError('INVALID_MESSAGE', 415)
  // Mirror apps/server/src/server.ts: stream with a hard 16 KiB cap instead of
  // buffering an arbitrary client body before checking its size.
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 16_384) {
      await reader.cancel()
      throw new ApiError('FRAME_TOO_LARGE', 413)
    }
    chunks.push(value)
  }
  const buffer = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as unknown
  } catch {
    throw new ApiError('INVALID_MESSAGE')
  }
}

/**
 * Single Durable Object that owns the self-hosted server state.
 *
 * - REST routes mirror apps/server/src/server.ts.
 * - WebSockets mirror apps/server/src/gateway.ts using the Workers Hibernation
 *   API so idle relays do not keep the object alive; peer identity lives in the
 *   socket attachment, link state lives in DO SQLite.
 * - Control frames stay byte-identical to the Node server; the relay never sees
 *   plaintext Remote messages.
 */
export class RemoteGateway implements DurableObject {
  private readonly store: Store
  private readonly config: ServerConfig
  private readonly peers = new Map<string, Peer>()
  private readonly links = new Map<string, Link>()
  private readonly rates = new WeakMap<WebSocket, RateWindow>()
  private readonly limits = new Map<string, { count: number; until: number }>()

  constructor(private readonly ctx: DurableObjectState, private readonly env: ServerEnv) {
    this.config = readConfig(env)
    this.store = new Store(ctx.storage.sql, { account: this.config.account, password: this.config.password })
    this.store.onInvalidate = deviceId => this.disconnect(deviceId, 'AUTH_INVALID')
    this.store.onPasswordChanged = () => this.disconnectAll('AUTH_INVALID')
    ctx.blockConcurrencyWhile(async () => { await this.store.initialize() })
  }

  async fetch(request: Request): Promise<Response> {
    this.ensurePeers()
    const url = new URL(request.url)
    if (url.pathname === '/ws/v1/connect') return this.acceptWebSocket(request)
    return this.handleApi(request)
  }

  // ---------------------------------------------------------------- WebSocket

  private async acceptWebSocket(request: Request): Promise<Response> {
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') return jsonResponse(400, { error: { code: 'INVALID_MESSAGE', message: 'INVALID_MESSAGE', requestId: crypto.randomUUID(), retryable: false } })
    const origin = request.headers.get('Origin')
    if (origin && origin !== this.config.origin) return jsonResponse(403, { error: { code: 'AUTH_INVALID', message: 'AUTH_INVALID', requestId: crypto.randomUUID(), retryable: false } })
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Forbidden', { status: 403 })
    const pair = new WebSocketPair()
    const client = pair[0] as WebSocket
    const server = pair[1] as WebSocket
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ acceptedAt: Date.now() } satisfies SocketAttachment)
    await this.ensureAlarm()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensurePeers()
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    let frame: ControlFrame | undefined
    try {
      if (typeof message !== 'string') throw new ApiError('INVALID_MESSAGE')
      const rate = this.rateOf(ws)
      const now = Date.now()
      if (now - rate.start >= 1000) {
        rate.start = now
        rate.frames = 0
        rate.bytes = 0
      }
      rate.frames += 1
      rate.bytes += new TextEncoder().encode(message).byteLength
      if (rate.frames > MAX_FRAMES_PER_SECOND || rate.bytes > MAX_BYTES_PER_SECOND) throw new ApiError('RATE_LIMITED')
      const envelope = JSON.parse(message) as { v?: unknown }
      if (envelope && envelope.v !== 1) throw new ApiError('UNSUPPORTED_VERSION')
      frame = decodeControlFrame(message)
      const peer = attachment?.deviceId ? this.peers.get(attachment.deviceId) : undefined
      if (!peer) {
        await this.handleHello(ws, frame)
        return
      }
      if (this.peers.get(peer.id) !== peer || peer.ws !== ws) throw new ApiError('AUTH_INVALID')
      this.store.get(peer.id)
      await this.handle(peer, frame)
    } catch (error) {
      this.handleFrameError(ws, message, frame, error)
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.releaseSocket(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.releaseSocket(ws)
  }

  private releaseSocket(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    this.ensurePeers()
    if (attachment?.deviceId) this.disconnect(attachment.deviceId, 'CONNECTION_FAILED')
  }

  private rateOf(ws: WebSocket): RateWindow {
    let rate = this.rates.get(ws)
    if (!rate) {
      rate = { start: Date.now(), frames: 0, bytes: 0 }
      this.rates.set(ws, rate)
    }
    return rate
  }

  private async handleHello(ws: WebSocket, frame: ControlFrame): Promise<void> {
    if (frame.type !== 'hello') throw new ApiError('AUTH_REQUIRED')
    const payload = frame.payload as HelloPayload
    const device = (await this.store.authenticate(payload.accessToken)).descriptor
    if (device.deviceId !== payload.deviceId || device.role !== payload.role) throw new ApiError('AUTH_INVALID')
    if (!payload.protocols.includes(1)) throw new ApiError('UNSUPPORTED_VERSION')
    this.disconnect(device.deviceId, 'CONNECTION_REPLACED')
    const version = payload.clientVersion ?? device.clientVersion
    const now = Date.now()
    const attachment: SocketAttachment = {
      acceptedAt: now,
      deviceId: device.deviceId,
      role: device.role,
      capabilities: payload.capabilities,
      version,
      lastPong: now,
    }
    ws.serializeAttachment(attachment)
    this.peers.set(device.deviceId, {
      ws,
      id: device.deviceId,
      role: device.role,
      capabilities: payload.capabilities,
      version,
      lastPong: now,
    })
    this.store.touch(device.deviceId, payload.clientVersion, payload.harnessVersion)
    this.send(ws, createControlFrame('hello.ack', {
      protocol: 1,
      serverVersion: 'self-hosted/0.1.0',
      connectionSessionId: crypto.randomUUID(),
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
      maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
      capabilities: payload.capabilities.includes('transport.relay') ? ['transport.relay'] : [],
      webrtcEnabled: false,
      webrtcFallbackTimeoutMs: 1,
    }))
    await this.ensureAlarm()
  }

  private handleFrameError(ws: WebSocket, message: string | ArrayBuffer, frame: ControlFrame | undefined, error: unknown): void {
    void message
    const code = error instanceof ApiError ? error.code : 'INVALID_MESSAGE'
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    this.ensurePeers()
    const current = attachment?.deviceId ? this.peers.get(attachment.deviceId) : undefined
    const connectionId = (frame?.payload as { connectionId?: unknown } | undefined)?.connectionId
    // Valid connection-scoped failures must not close the Host's other clients.
    if (current && typeof connectionId === 'string' && code !== 'RATE_LIMITED') {
      const link = this.links.get(connectionId)
      if (link && (link.host === current.id || link.client === current.id)) this.dropLink(link, code)
      else this.send(ws, createControlFrame('error', { code, message: code, connectionId, retryable: false }))
      return
    }
    this.send(ws, createControlFrame('error', { code, message: code, retryable: false }))
    if (current) this.disconnect(current.id, code)
    else {
      try { ws.close(4001, code) } catch { /* already closed */ }
    }
  }

  private async handle(peer: Peer, frame: ControlFrame): Promise<void> {
    const payload = frame.payload as Record<string, unknown>
    if (frame.type === 'ping') {
      this.send(peer.ws, createControlFrame('pong', { nonce: payload.nonce }))
      return
    }
    if (frame.type === 'pong') {
      if (peer.nonce && payload.nonce === peer.nonce) {
        peer.lastPong = Date.now()
        peer.nonce = undefined
        const attachment = peer.ws.deserializeAttachment() as SocketAttachment | null
        if (attachment) {
          attachment.lastPong = peer.lastPong
          attachment.nonce = undefined
          peer.ws.serializeAttachment(attachment)
        }
      }
      return
    }
    if (frame.type === 'connect.request') {
      await this.handleConnectRequest(peer, frame.payload as ConnectRequestPayload)
      return
    }
    const id = payload.connectionId
    const link = typeof id === 'string' ? this.links.get(id) : undefined
    if (!link || (peer.id !== link.host && peer.id !== link.client)) throw new ApiError('CONNECTION_NOT_FOUND')
    const otherId = peer.id === link.host ? link.client : link.host
    const other = this.peers.get(otherId)
    this.store.get(otherId)
    if (!other) throw new ApiError('CONNECTION_FAILED')
    if (frame.type === 'connect.accepted' || frame.type === 'connect.rejected') {
      if (peer.id !== link.host || link.stage !== 'pending') throw new ApiError('INVALID_MESSAGE')
      if (frame.type === 'connect.rejected') {
        this.links.delete(link.id)
        this.store.deleteLink(link.id)
      } else {
        link.stage = 'accepted'
        this.store.setLinkStage(link.id, 'accepted')
      }
      this.send(other.ws, frame)
      return
    }
    if (payload.targetDeviceId !== otherId || link.stage === 'pending') throw new ApiError('CONNECTION_NOT_FOUND')
    if (frame.type === 'transport.selected') {
      if (peer.id !== link.client || (frame.payload as TransportSelectedPayload).transport !== 'relay') throw new ApiError('CAPABILITY_NOT_SUPPORTED')
      if (modernHost(other.version)) this.send(other.ws, frame)
      return
    }
    if (frame.type.startsWith('signal.')) return // Relay-only negotiation: no signaling forwarding.
    if (frame.type === 'secure.handshake') {
      const step = (frame.payload as SecureHandshakePayload).step
      if (step === 1 && peer.id === link.client && link.stage === 'accepted') {
        link.stage = 'handshake'
        this.store.setLinkStage(link.id, 'handshake')
      } else if (step === 2 && peer.id === link.host && link.stage === 'handshake') {
        link.stage = 'ready'
        this.store.setLinkStage(link.id, 'ready')
      } else {
        throw new ApiError('INVALID_MESSAGE')
      }
    } else if (frame.type === 'relay') {
      const counter = (frame.payload as RelayPayload).counter
      if (link.stage !== 'ready' || counter <= (link.counters.get(peer.id) ?? -1)) throw new ApiError('INVALID_MESSAGE')
      link.counters.set(peer.id, counter)
      this.store.setLinkCounters(link.id, Object.fromEntries(link.counters))
    } else {
      throw new ApiError('INVALID_MESSAGE')
    }
    this.send(other.ws, frame)
  }

  private async handleConnectRequest(peer: Peer, request: ConnectRequestPayload): Promise<void> {
    if (peer.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED')
    const host = this.peers.get(request.hostDeviceId)
    if (!host || host.role !== 'host') {
      this.send(peer.ws, createControlFrame('error', { code: 'HOST_OFFLINE', message: 'Host is offline.', retryable: true }))
      return
    }
    this.store.get(host.id)
    if (!request.preferredTransports.includes('relay') || !peer.capabilities.includes('transport.relay') || !host.capabilities.includes('transport.relay')) {
      throw new ApiError('CAPABILITY_NOT_SUPPORTED')
    }
    for (const old of [...this.links.values()]) {
      if (old.client === peer.id || (old.host === host.id && !modernHost(host.version))) this.dropLink(old, 'CONNECTION_REPLACED')
    }
    if (this.links.size >= MAX_LINKS) throw new ApiError('RATE_LIMITED', 429)
    const link: Link = { id: crypto.randomUUID(), host: host.id, client: peer.id, stage: 'pending', created: Date.now(), counters: new Map() }
    this.links.set(link.id, link)
    this.store.insertLink({ ...link, counters: {} })
    const client = this.store.get(peer.id)
    this.send(host.ws, createControlFrame('connect.incoming', {
      connectionId: link.id,
      clientDeviceId: peer.id,
      clientIdentityKey: client.descriptor.identityKey,
      authorization: 'account',
      preferredTransports: ['relay'],
    }))
  }

  private send(ws: WebSocket, frame: ControlFrame): void {
    try {
      if (ws.readyState !== 1) return
      ws.send(JSON.stringify(frame))
    } catch { /* socket closed between check and send */ }
  }

  private dropLink(link: Link, code: string): void {
    this.links.delete(link.id)
    this.store.deleteLink(link.id)
    for (const id of [link.host, link.client]) {
      const peer = this.peers.get(id)
      if (peer && (peer.role === 'client' || modernHost(peer.version))) {
        this.send(peer.ws, createControlFrame('error', { code, message: code, connectionId: link.id, retryable: true }))
      }
    }
  }

  private disconnect(id: string, code: string): void {
    this.ensurePeers()
    const peer = this.peers.get(id)
    this.peers.delete(id)
    for (const link of [...this.links.values()]) {
      if (link.host === id || link.client === id) this.dropLink(link, code)
    }
    if (peer) {
      try { peer.ws.close(code === 'CONNECTION_REPLACED' ? 4003 : 4001, code) } catch { /* already closed */ }
    }
  }

  private disconnectAll(code: string): void {
    this.ensurePeers()
    for (const id of [...this.peers.keys()]) this.disconnect(id, code)
  }

  private ensurePeers(): void {
    const sockets = this.ctx.getWebSockets()
    const live = new Set<WebSocket>(sockets)
    for (const [id, peer] of this.peers) if (!live.has(peer.ws)) this.peers.delete(id)
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null
      if (!attachment?.deviceId || this.peers.has(attachment.deviceId)) continue
      this.peers.set(attachment.deviceId, {
        ws,
        id: attachment.deviceId,
        role: attachment.role ?? 'client',
        capabilities: attachment.capabilities ?? [],
        version: attachment.version ?? '',
        lastPong: attachment.lastPong ?? Date.now(),
        nonce: attachment.nonce,
      })
    }
  }

  // -------------------------------------------------------------- heartbeat

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS)
  }

  async alarm(): Promise<void> {
    this.ensurePeers()
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null
      if (!attachment) continue
      if (!attachment.deviceId) {
        if (now - attachment.acceptedAt > HELLO_TIMEOUT_MS) {
          try { ws.close(4001, 'AUTH_REQUIRED') } catch { /* already closed */ }
        }
        continue
      }
      if (now - (attachment.lastPong ?? attachment.acceptedAt) > HEARTBEAT_TIMEOUT_MS) {
        this.disconnect(attachment.deviceId, 'CONNECTION_FAILED')
        continue
      }
      attachment.nonce = crypto.randomUUID()
      ws.serializeAttachment(attachment)
      const peer = this.peers.get(attachment.deviceId)
      if (peer) peer.nonce = attachment.nonce
      this.send(ws, createControlFrame('ping', { nonce: attachment.nonce }))
    }
    for (const link of this.store.listLinks()) {
      if (link.stage === 'ready' || now - link.created <= PENDING_LINK_TIMEOUT_MS) continue
      const cached = this.links.get(link.id)
      if (cached) this.dropLink(cached, 'CONNECTION_FAILED')
      else this.store.deleteLink(link.id)
    }
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS)
  }

  // ------------------------------------------------------------------- REST

  private async handleApi(request: Request): Promise<Response> {
    try {
      return await this.routeApi(request)
    } catch (error) {
      return this.errorResponse(error)
    } finally {
      // Routes that do not consume a body (logout, DELETE, GET) must still drain
      // it. Cancelling the inner stream is not enough: workerd only pulls the
      // forwarded request body to completion when it is read, otherwise the
      // outer fetch event reports "Can't read from request stream after response
      // has been sent" after the response is returned.
      if (!request.bodyUsed) {
        try {
          const reader = request.body?.getReader()
          while (reader) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch { /* already consumed or aborted */ }
      }
    }
  }

  private async routeApi(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const method = request.method
    {
      const origin = request.headers.get('Origin')
      if (origin && origin !== this.config.origin) throw new ApiError('AUTH_INVALID', 403)
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError('AUTH_INVALID', 403)
      this.rate(`api:${this.clientIp(request)}`, 240)
      if (method === 'POST' && path === '/api/v1/auth/login') {
        this.rate(`login:${this.clientIp(request)}`, 20)
        const credentials = loginSchema.parse(await readJson(request))
        if (!equal(credentials.email.trim(), this.config.account) || !equal(credentials.password, this.config.password)) throw new ApiError('AUTH_INVALID', 401)
        const session = await this.store.createSession()
        return jsonResponse(200, { ...this.profile(), token: session.value, expiresAt: session.expiresAt }, { 'Set-Cookie': this.cookie(session.value, 8 * 3600) })
      }
      if (method === 'GET' && path === '/api/v1/auth/me') {
        await this.accountAuth(request)
        return jsonResponse(200, this.profile())
      }
      if (method === 'POST' && path === '/api/v1/auth/logout') {
        await this.store.deleteSession(this.token(request))
        return jsonResponse(200, { status: 'ok' }, { 'Set-Cookie': this.cookie('', 0) })
      }
      if (method === 'GET' && path === '/api/v1/account/devices') {
        await this.accountAuth(request)
        return jsonResponse(200, { items: await Promise.all(this.store.list().map(saved => this.descriptor(saved))), serverUrl: this.config.origin, transport: 'relay' })
      }
      if (method === 'POST' && (path === '/api/v1/devices/register' || path === '/api/v1/devices/register-owned-role')) {
        const owned = path.endsWith('register-owned-role')
        const source = owned ? await this.deviceAuth(request) : undefined
        if (!source) await this.accountAuth(request)
        const { device } = deviceRegistrationRequestSchema.parse(await readJson(request))
        if (source && (source.descriptor.deviceId === device.deviceId || source.descriptor.role === device.role)) throw new ApiError('INVALID_MESSAGE', 409)
        return jsonResponse(200, await this.store.register(device))
      }
      if (method === 'POST' && path === '/api/v1/auth/refresh') {
        const data = deviceRefreshRequestSchema.parse(await readJson(request))
        return jsonResponse(200, await this.store.refresh(data.deviceId, data.refreshToken))
      }
      if (method === 'DELETE' && path === '/api/v1/devices/self') {
        const source = await this.deviceAuth(request)
        this.store.revoke(source.descriptor.deviceId)
        return jsonResponse(200, { status: 'revoked' })
      }
      if (method === 'GET' && path === '/api/v1/me') {
        const source = await this.deviceAuth(request)
        return jsonResponse(200, await this.descriptor(source))
      }
      if (method === 'GET' && path === '/api/v1/devices') {
        const source = await this.deviceAuth(request)
        if (source.descriptor.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
        const items = await Promise.all(this.store.list()
          .filter(saved => saved.descriptor.role === 'host')
          .map(async saved => {
            const { identityKey: _identityKey, ...item } = await this.descriptor(saved)
            return item
          }))
        return jsonResponse(200, { items, nextCursor: null })
      }
      const match = /^\/api\/v1\/devices\/([^/]+?)(\/presence)?$/u.exec(path)
      if (method === 'GET' && match) {
        const source = await this.deviceAuth(request)
        const target = this.store.get(match[1]!)
        if (source.descriptor.role === target.descriptor.role) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
        const descriptor = await this.descriptor(target)
        return jsonResponse(200, match[2] ? { deviceId: descriptor.deviceId, online: descriptor.online, lastSeenAt: descriptor.lastSeenAt } : descriptor)
      }
      throw new ApiError('METHOD_NOT_FOUND', 404)
    }
  }

  private profile() {
    return { account: this.config.account, profile: { displayName: this.config.account }, isAdmin: false }
  }

  private async descriptor(saved: SavedDevice) {
    return {
      ...saved.descriptor,
      membershipId: `account:${(await hash(this.config.account)).slice(0, 16)}`,
      online: this.peers.has(saved.descriptor.deviceId),
      lastSeenAt: saved.lastSeenAt,
    }
  }

  private token(request: Request): string {
    const authorization = request.headers.get('Authorization')
    if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/u.exec(request.headers.get('Cookie') ?? '')?.[1] ?? ''
  }

  private async accountAuth(request: Request): Promise<void> {
    await this.store.authenticateAccount(this.token(request))
  }

  private async deviceAuth(request: Request): Promise<SavedDevice> {
    const authorization = request.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) throw new ApiError('AUTH_REQUIRED', 401)
    return this.store.authenticate(authorization.slice(7))
  }

  private clientIp(request: Request): string {
    const connecting = request.headers.get('CF-Connecting-IP')
    if (connecting) return connecting
    return request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown'
  }

  private rate(key: string, max: number): void {
    for (const [k, value] of this.limits) if (value.until < Date.now()) this.limits.delete(k)
    let entry = this.limits.get(key)
    if (!entry) {
      if (this.limits.size >= 4096) throw new ApiError('RATE_LIMITED', 429)
      entry = { count: 0, until: Date.now() + 60_000 }
      this.limits.set(key, entry)
    }
    entry.count += 1
    if (entry.count > max) throw new ApiError('RATE_LIMITED', 429)
  }

  private cookie(value: string, age: number): string {
    return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.config.secure ? '; Secure' : ''}`
  }

  private errorResponse(error: unknown): Response {
    const apiError = error instanceof ApiError
      ? error
      : error instanceof z.ZodError
        ? new ApiError('INVALID_MESSAGE')
        : new ApiError('INTERNAL_ERROR', 500)
    const headers: Record<string, string> = {}
    if (apiError.status === 429) headers['Retry-After'] = '60'
    return jsonResponse(apiError.status, {
      error: {
        code: apiError.code,
        message: apiError.code,
        requestId: crypto.randomUUID(),
        retryable: apiError.status === 429 || apiError.status >= 500,
      },
    }, headers)
  }
}
