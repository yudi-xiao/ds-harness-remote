import { Directory, File, FileMode, Paths } from 'expo-file-system'
import type { ChatVideo } from '../types'
import type { SessionTools } from './session-tools'

/** Large enough for a 15 s H3 MP4, small enough to keep the JS/client cache bounded. */
export const MAX_CHAT_VIDEO_BYTES = 120 * 1024 * 1024
export const CHAT_VIDEO_CHUNK_BYTES = 512 * 1024
export const CHAT_VIDEO_CACHE_DIR = 'chat-videos'

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export const CHAT_VIDEO_INVALID = 'chat-video/invalid'
export const CHAT_VIDEO_TOO_LARGE = 'chat-video/too-large'
export const CHAT_VIDEO_CHANGED = 'chat-video/changed'
export const CHAT_VIDEO_ABORTED = 'RPC_ABORTED'

interface CachedVideo {
  uri: string
  bytes: number
  version: string
}

interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (loaded: number, total: number | undefined) => void
}

const cache = new Map<string, CachedVideo>()

function keyFor(sessionId: string, video: ChatVideo): string {
  return `${sessionId}\u0000${video.workspacePath}`
}

function videoError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw videoError(CHAT_VIDEO_ABORTED, 'The video download was cancelled.')
}

/** Only workspace-relative MP4 paths may enter the official read-only file scope. */
export function isSafeWorkspaceVideoPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false
  if (value.includes('\\') || value.includes(':') || value.includes('\0') || value.startsWith('/')) return false
  if (!value.toLowerCase().endsWith('.mp4')) return false
  return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Synchronous cache lookup; the caller must still verify that the file exists. */
export function cachedChatVideo(sessionId: string, video: ChatVideo): { uri: string; bytes: number } | undefined {
  const entry = cache.get(keyFor(sessionId, video))
  if (entry === undefined) return undefined
  if (video.bytes !== undefined && entry.bytes !== video.bytes) {
    cache.delete(keyFor(sessionId, video))
    return undefined
  }
  const file = new File(entry.uri)
  if (!file.exists || file.size !== entry.bytes) {
    cache.delete(keyFor(sessionId, video))
    return undefined
  }
  return { uri: entry.uri, bytes: entry.bytes }
}

/**
 * Stream one workspace video into the app cache. Chunks go through the
 * official `workspaceFiles/readBytes` scope; the MP4 is written to a file
 * instead of being kept as a JS string or data URI.
 */
export async function downloadChatVideo(
  tools: SessionTools,
  sessionId: string,
  video: ChatVideo,
  options: DownloadOptions = {},
): Promise<{ uri: string; bytes: number }> {
  const { signal, onProgress } = options
  if (!isSafeWorkspaceVideoPath(video.workspacePath)) throw videoError(CHAT_VIDEO_INVALID, 'The video path is not a workspace MP4 path.')
  const cached = cachedChatVideo(sessionId, video)
  if (cached !== undefined) return cached
  assertActive(signal)
  const before = await tools.statFile(sessionId, video.workspacePath, signal)
  assertActive(signal)
  const total = before.bytes
  if (total !== undefined && (total <= 0 || total > MAX_CHAT_VIDEO_BYTES)) {
    throw videoError(CHAT_VIDEO_TOO_LARGE, 'The video exceeds the in-app playback size limit.')
  }
  const directory = new Directory(Paths.cache, CHAT_VIDEO_CACHE_DIR)
  directory.create({ intermediates: true, idempotent: true })
  const file = new File(directory, fileNameFor(sessionId, video, before.version))
  if (file.exists) file.delete()
  else file.create({ overwrite: true })
  const handle = file.open(FileMode.WriteOnly)
  let read = 0
  try {
    for (;;) {
      assertActive(signal)
      const length = total === undefined
        ? Math.min(CHAT_VIDEO_CHUNK_BYTES, MAX_CHAT_VIDEO_BYTES + 1 - read)
        : Math.min(CHAT_VIDEO_CHUNK_BYTES, Math.max(1, total - read))
      const chunk = parseChunk(await tools.readBytes(sessionId, video.workspacePath, read, length, signal))
      if (chunk.offset !== read) throw videoError(CHAT_VIDEO_CHANGED, 'The Host returned an unexpected video chunk offset.')
      if (chunk.data.byteLength === 0) throw videoError(CHAT_VIDEO_CHANGED, 'The Host returned an empty video chunk.')
      handle.writeBytes(chunk.data)
      read += chunk.data.byteLength
      if (read > MAX_CHAT_VIDEO_BYTES) throw videoError(CHAT_VIDEO_TOO_LARGE, 'The video exceeds the in-app playback size limit.')
      onProgress?.(read, total ?? chunk.totalBytes)
      if (chunk.eof) break
      if (total !== undefined && read >= total) break
    }
    assertActive(signal)
    if (total !== undefined && read !== total) throw videoError(CHAT_VIDEO_CHANGED, 'The video size changed while it was being read.')
    const after = await tools.statFile(sessionId, video.workspacePath, signal)
    if (after.version !== before.version) throw videoError(CHAT_VIDEO_CHANGED, 'The video changed while it was being read.')
    handle.close()
    if (file.size !== read) {
      file.delete()
      throw videoError(CHAT_VIDEO_CHANGED, 'The local video cache is incomplete.')
    }
    const entry = { uri: file.uri, bytes: read, version: before.version }
    cache.set(keyFor(sessionId, video), entry)
    return { uri: entry.uri, bytes: entry.bytes }
  } catch (error) {
    try {
      handle.close()
    } catch {
      // already closed
    }
    try {
      if (file.exists) file.delete()
    } catch {
      // cache cleanup is best-effort
    }
    throw error
  }
}

/** Remove every cached video file, used on sign-out/reset. */
export function clearChatVideoCache(): void {
  cache.clear()
  try {
    const directory = new Directory(Paths.cache, CHAT_VIDEO_CACHE_DIR)
    if (directory.exists) directory.delete()
  } catch {
    // best-effort cleanup
  }
}

function fileNameFor(sessionId: string, video: ChatVideo, version: string): string {
  const name = video.workspacePath.slice(video.workspacePath.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/gu, '_').slice(-64)
  return `${hash(`${sessionId}\u0000${video.workspacePath}\u0000${version}`)}-${name === '' ? 'video.mp4' : name}`
}

function hash(value: string): string {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193) >>> 0
  }
  return result.toString(16).padStart(8, '0')
}

function parseChunk(value: unknown): { offset: number; data: Uint8Array; eof: boolean; totalBytes?: number } {
  if (!isRecord(value)) throw videoError(CHAT_VIDEO_INVALID, 'The Host returned an invalid video chunk.')
  const offset = value.offset
  const data = value.data
  const eof = value.eof
  const totalBytes = value.bytes
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw videoError(CHAT_VIDEO_INVALID, 'The video chunk offset is invalid.')
  if (typeof data !== 'string' || !CANONICAL_BASE64.test(data) || data.length % 4 !== 0) throw videoError(CHAT_VIDEO_INVALID, 'The video chunk is not canonical base64.')
  if (typeof eof !== 'boolean') throw videoError(CHAT_VIDEO_INVALID, 'The video chunk is missing its EOF flag.')
  if (totalBytes !== undefined && (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0)) {
    throw videoError(CHAT_VIDEO_INVALID, 'The video chunk size hint is invalid.')
  }
  const bytes = base64Bytes(data)
  if (bytes.byteLength > CHAT_VIDEO_CHUNK_BYTES) throw videoError(CHAT_VIDEO_INVALID, 'The video chunk exceeds the requested size.')
  return { offset, data: bytes, eof, ...(totalBytes === undefined ? {} : { totalBytes }) }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) table[BASE64_ALPHABET.charCodeAt(index)] = index
  return table
})()

/** Hermes has no guaranteed atob; decode the validated canonical base64 ourselves. */
function base64Bytes(value: string): Uint8Array {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const length = (value.length / 4) * 3 - padding
  const bytes = new Uint8Array(length)
  let written = 0
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_LOOKUP[value.charCodeAt(index)] ?? -1
    const b = BASE64_LOOKUP[value.charCodeAt(index + 1)] ?? -1
    const c = value.charCodeAt(index + 2) === 61 ? -2 : (BASE64_LOOKUP[value.charCodeAt(index + 2)] ?? -1)
    const d = value.charCodeAt(index + 3) === 61 ? -2 : (BASE64_LOOKUP[value.charCodeAt(index + 3)] ?? -1)
    if (a < 0 || b < 0 || c === -1 || d === -1) throw videoError(CHAT_VIDEO_INVALID, 'The video chunk is not canonical base64.')
    bytes[written++] = (a << 2) | (b >> 4)
    if (written < length && c >= 0) bytes[written++] = ((b & 15) << 4) | (c >> 2)
    if (written < length && d >= 0 && c >= 0) bytes[written++] = ((c & 3) << 6) | d
  }
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
