import { accountDeviceDescriptorSchema, type AccountDeviceDescriptor } from '@dsh-remote/protocol'
import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}

const encoder = new TextEncoder()
const HEX = '0123456789abcdef'
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 0x0f]!
  return out
}
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** 32 random bytes, unpadded base64url. */
export function secret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

export async function hash(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

/** Constant-time comparison for secrets and digests. */
export function equal(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let index = 0; index < a.byteLength; index += 1) diff |= a[index]! ^ b[index]!
  return diff === 0
}

/**
 * Salted password verifier. Workers WebCrypto has no scrypt; HMAC-SHA256 with a
 * random salt keeps plaintext out of DO storage while staying cheap enough to
 * re-check on every Durable Object cold start (the deployment password itself is
 * already kept in Worker secrets).
 */
export async function passwordVerifier(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(salt))))
}

const savedDeviceSchema = z.object({
  descriptor: accountDeviceDescriptorSchema,
  revoked: z.boolean(),
  lastSeenAt: z.number(),
})
export type SavedDevice = z.infer<typeof savedDeviceSchema>

export type TokenRecord = { kind: 'access' | 'refresh'; deviceId: string; expires: number; used: boolean }

export interface LinkRow {
  id: string
  host: string
  client: string
  stage: 'pending' | 'accepted' | 'handshake' | 'ready'
  created: number
  counters: Record<string, number>
}

export interface StoreConfig {
  account: string
  password: string
}

interface DeviceRow { device_id: string; descriptor: string; revoked: number; last_seen_at: number }
interface TokenRow { kind: string; device_id: string; expires: number; used: number }
interface CountRow { count: number }
interface LinkDbRow { id: string; host: string; client: string; stage: string; created: number; counters: string }

/** Single-account credential store backed by Durable Object SQLite. */
export class Store {
  onInvalidate: (deviceId: string) => void = () => {}
  onPasswordChanged: () => void = () => {}
  private initialized: Promise<void> | undefined
  private account = ''

  constructor(private readonly sql: SqlStorage, private readonly config: StoreConfig) {}

  initialize(): Promise<void> {
    this.initialized ??= this.doInitialize()
    return this.initialized
  }

  private exec(statement: string, ...bindings: (string | number | null)[]): SqlStorageCursor<Record<string, SqlStorageValue>> {
    return (this.sql.exec as unknown as (sql: string, ...bindings: (string | number | null)[]) => SqlStorageCursor<Record<string, SqlStorageValue>>)(statement, ...bindings)
  }

  private query<T>(statement: string, ...bindings: (string | number | null)[]): T[] {
    return this.exec(statement, ...bindings).toArray() as unknown as T[]
  }

  private count(table: 'devices' | 'tokens'): number {
    return Number(this.query<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0)
  }

  private async doInitialize(): Promise<void> {
    this.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.exec('CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL DEFAULT 0)')
    this.exec('CREATE TABLE IF NOT EXISTS tokens (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, device_id TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)')
    this.exec('CREATE INDEX IF NOT EXISTS tokens_device ON tokens (device_id)')
    this.exec('CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL)')
    this.exec('CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, host TEXT NOT NULL, client TEXT NOT NULL, stage TEXT NOT NULL, created INTEGER NOT NULL, counters TEXT NOT NULL)')

    const account = this.config.account.trim()
    if (!account) throw new Error('DSH_SERVER_ACCOUNT is required.')
    if (this.config.password.length < 12) throw new Error('DSH_SERVER_PASSWORD must be at least 12 characters.')
    const meta = new Map(this.query<{ key: string; value: string }>('SELECT key, value FROM meta').map(row => [row.key, row.value]))
    const salt = meta.get('salt') ?? secret()
    const verifier = await passwordVerifier(this.config.password, salt)
    const accountChanged = meta.has('account') && meta.get('account') !== account
    const passwordChanged = meta.has('verifier') && !equal(meta.get('verifier')!, verifier)
    if (accountChanged) {
      this.exec('DELETE FROM devices')
      this.exec('DELETE FROM tokens')
      this.exec('DELETE FROM sessions')
    } else if (passwordChanged) {
      this.exec('DELETE FROM tokens')
      this.exec('DELETE FROM sessions')
    }
    this.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'account', account)
    this.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'salt', salt)
    this.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'verifier', verifier)
    this.account = account
    if (accountChanged || passwordChanged) this.onPasswordChanged()
  }

  get accountName(): string { return this.account }

  get(id: string): SavedDevice {
    const row = this.query<DeviceRow>('SELECT descriptor, revoked, last_seen_at FROM devices WHERE device_id = ?', id)[0]
    if (!row) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (row.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    return { descriptor: accountDeviceDescriptorSchema.parse(JSON.parse(row.descriptor)), revoked: false, lastSeenAt: row.last_seen_at }
  }

  list(): SavedDevice[] {
    return this.query<DeviceRow>('SELECT descriptor, revoked, last_seen_at FROM devices WHERE revoked = 0 ORDER BY rowid').map(row => ({
      descriptor: accountDeviceDescriptorSchema.parse(JSON.parse(row.descriptor)),
      revoked: false,
      lastSeenAt: row.last_seen_at,
    }))
  }

  async register(descriptor: AccountDeviceDescriptor): Promise<Awaited<ReturnType<Store['issue']>>> {
    const row = this.query<DeviceRow>('SELECT descriptor, revoked, last_seen_at FROM devices WHERE device_id = ?', descriptor.deviceId)[0]
    if (row?.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    if (row) {
      const old = accountDeviceDescriptorSchema.parse(JSON.parse(row.descriptor))
      if (old.identityKey !== descriptor.identityKey || old.role !== descriptor.role) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    } else if (this.count('devices') >= 256) {
      throw new ApiError('RATE_LIMITED', 429)
    }
    this.exec(
      'INSERT INTO devices (device_id, descriptor, revoked, last_seen_at) VALUES (?, ?, 0, 0) ON CONFLICT(device_id) DO UPDATE SET descriptor = excluded.descriptor, revoked = 0',
      descriptor.deviceId,
      JSON.stringify(descriptor),
    )
    this.invalidate(descriptor.deviceId)
    return this.issue(descriptor.deviceId)
  }

  private async issue(deviceId: string, refreshTokenExpiresAt = Date.now() + 30 * 86400_000) {
    this.exec('DELETE FROM tokens WHERE expires <= ?', Date.now())
    if (this.count('tokens') >= 16384) throw new ApiError('RATE_LIMITED', 429)
    const accessToken = secret()
    const refreshToken = secret()
    const accessTokenExpiresAt = Date.now() + 3600_000
    this.exec('INSERT INTO tokens (digest, kind, device_id, expires, used) VALUES (?, ?, ?, ?, 0)', await hash(accessToken), 'access', deviceId, accessTokenExpiresAt)
    this.exec('INSERT INTO tokens (digest, kind, device_id, expires, used) VALUES (?, ?, ?, ?, 0)', await hash(refreshToken), 'refresh', deviceId, refreshTokenExpiresAt)
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }

  async authenticate(token: string): Promise<SavedDevice> {
    const row = this.query<TokenRow>('SELECT kind, device_id, expires, used FROM tokens WHERE digest = ?', await hash(token))[0]
    if (!row || row.kind !== 'access') throw new ApiError('AUTH_INVALID', 401)
    if (row.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    return this.get(row.device_id)
  }

  async refresh(deviceId: string, token: string) {
    this.get(deviceId)
    const digest = await hash(token)
    const row = this.query<TokenRow>('SELECT kind, device_id, expires, used FROM tokens WHERE digest = ?', digest)[0]
    if (!row || row.kind !== 'refresh' || row.device_id !== deviceId) throw new ApiError('AUTH_INVALID', 401)
    if (row.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    if (row.used) {
      this.invalidate(deviceId)
      throw new ApiError('AUTH_INVALID', 401)
    }
    this.exec('UPDATE tokens SET used = 1 WHERE digest = ?', digest)
    return this.issue(deviceId, row.expires)
  }

  invalidate(deviceId: string): void {
    this.exec('DELETE FROM tokens WHERE device_id = ?', deviceId)
    this.onInvalidate(deviceId)
  }

  revoke(id: string): void {
    this.get(id)
    this.exec('UPDATE devices SET revoked = 1 WHERE device_id = ?', id)
    this.invalidate(id)
  }

  touch(id: string, clientVersion?: string, harnessVersion?: string): void {
    const saved = this.get(id)
    const descriptor = { ...saved.descriptor }
    if (clientVersion) descriptor.clientVersion = clientVersion.slice(0, 64)
    if (descriptor.role === 'host' && harnessVersion) descriptor.harnessVersion = harnessVersion.slice(0, 64)
    this.exec('UPDATE devices SET last_seen_at = ?, descriptor = ? WHERE device_id = ?', Date.now(), JSON.stringify(descriptor), id)
  }

  async createSession(): Promise<{ value: string; expiresAt: number }> {
    this.exec('DELETE FROM sessions WHERE expires <= ?', Date.now())
    const count = Number(this.query<CountRow>('SELECT COUNT(*) AS count FROM sessions')[0]?.count ?? 0)
    if (count >= 256) throw new ApiError('RATE_LIMITED', 429)
    const value = secret()
    const expiresAt = Date.now() + 8 * 3600_000
    this.exec('INSERT INTO sessions (digest, expires) VALUES (?, ?)', await hash(value), expiresAt)
    return { value, expiresAt }
  }

  async authenticateAccount(token: string): Promise<void> {
    if (!token) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
    const row = this.query<{ expires: number }>('SELECT expires FROM sessions WHERE digest = ?', await hash(token))[0]
    if (!row || row.expires <= Date.now()) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
  }

  async deleteSession(token: string): Promise<void> {
    this.exec('DELETE FROM sessions WHERE digest = ?', await hash(token))
  }

  getLink(id: string): LinkRow | undefined {
    const row = this.query<LinkDbRow>('SELECT id, host, client, stage, created, counters FROM links WHERE id = ?', id)[0]
    if (!row) return undefined
    return { ...row, stage: row.stage as LinkRow['stage'], counters: JSON.parse(row.counters) as Record<string, number> }
  }

  listLinks(): LinkRow[] {
    return this.query<LinkDbRow>('SELECT id, host, client, stage, created, counters FROM links').map(row => ({
      ...row,
      stage: row.stage as LinkRow['stage'],
      counters: JSON.parse(row.counters) as Record<string, number>,
    }))
  }

  insertLink(link: LinkRow): void {
    this.exec('INSERT INTO links (id, host, client, stage, created, counters) VALUES (?, ?, ?, ?, ?, ?)', link.id, link.host, link.client, link.stage, link.created, JSON.stringify(link.counters))
  }

  setLinkStage(id: string, stage: LinkRow['stage']): void {
    this.exec('UPDATE links SET stage = ? WHERE id = ?', stage, id)
  }

  setLinkCounters(id: string, counters: Record<string, number>): void {
    this.exec('UPDATE links SET counters = ? WHERE id = ?', JSON.stringify(counters), id)
  }

  deleteLink(id: string): void {
    this.exec('DELETE FROM links WHERE id = ?', id)
  }
}

export type { AccountDeviceDescriptor, TokenRecord as StoreTokenRecord }
