import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-file-system', () => {
  const files = new Map<string, number[]>()
  const directories = new Set<string>()
  const uriFor = (parts: unknown[]): string => parts.map(part => typeof part === 'string' ? part : (part as { uri?: string }).uri ?? '').join('/')
  class MockDirectory {
    readonly uri: string
    constructor(...parts: unknown[]) { this.uri = uriFor(parts) }
    get exists(): boolean { return directories.has(this.uri) }
    create(): void { directories.add(this.uri) }
    delete(): void {
      directories.delete(this.uri)
      for (const key of [...files.keys()]) if (key.startsWith(`${this.uri}/`)) files.delete(key)
    }
  }
  class MockFile {
    readonly uri: string
    constructor(...parts: unknown[]) { this.uri = uriFor(parts) }
    get exists(): boolean { return files.has(this.uri) }
    get size(): number { return files.get(this.uri)?.length ?? 0 }
    create(): void { if (!files.has(this.uri)) files.set(this.uri, []) }
    delete(): void { files.delete(this.uri) }
    open(): { writeBytes: (bytes: Uint8Array) => void; close: () => void } {
      if (!files.has(this.uri)) files.set(this.uri, [])
      return {
        writeBytes: (bytes: Uint8Array) => { files.get(this.uri)!.push(...bytes) },
        close: () => undefined,
      }
    }
  }
  return {
    Directory: MockDirectory,
    File: MockFile,
    FileMode: { WriteOnly: 'w' },
    Paths: { cache: new MockDirectory('file:///cache') },
    __files: files,
  }
})

import {
  cachedChatVideo,
  CHAT_VIDEO_CHANGED,
  CHAT_VIDEO_INVALID,
  CHAT_VIDEO_TOO_LARGE,
  downloadChatVideo,
  isSafeWorkspaceVideoPath,
  MAX_CHAT_VIDEO_BYTES,
} from '../src/services/chat-video'
import type { ChatVideo } from '../src/types'

const video: ChatVideo = {
  workspacePath: '_scratch/videos/clip.mp4',
  mediaType: 'video/mp4',
  bytes: 1300,
}

interface ChunkLike {
  offset: number
  bytes?: number
  data: string
  eof: boolean
}

function fakeTools(payload: Uint8Array, statBytes: number | undefined = payload.length) {
  return {
    statFile: vi.fn(async () => ({ absolutePath: '/workspace/_scratch/videos/clip.mp4', version: 'v1', ...(statBytes === undefined ? {} : { bytes: statBytes }) })),
    readBytes: vi.fn(async (_session: string, _path: string, offset: number, length: number): Promise<ChunkLike> => {
      const slice = payload.subarray(offset, Math.min(offset + length, payload.length))
      return {
        offset,
        ...(statBytes === undefined ? {} : { bytes: statBytes }),
        data: Buffer.from(slice).toString('base64'),
        eof: offset + slice.byteLength >= payload.length,
      }
    }),
  }
}

beforeEach(async () => {
  const mocked = await import('expo-file-system') as unknown as { __files: Map<string, number[]> }
  mocked.__files.clear()
})

describe('workspace chat video playback', () => {
  it('only accepts safe workspace-relative MP4 paths', () => {
    expect(isSafeWorkspaceVideoPath('_scratch/videos/clip.mp4')).toBe(true)
    expect(isSafeWorkspaceVideoPath('videos/a b.mp4')).toBe(true)
    expect(isSafeWorkspaceVideoPath('../clip.mp4')).toBe(false)
    expect(isSafeWorkspaceVideoPath('a/../../b.mp4')).toBe(false)
    expect(isSafeWorkspaceVideoPath('/abs/clip.mp4')).toBe(false)
    expect(isSafeWorkspaceVideoPath('a\\b.mp4')).toBe(false)
    expect(isSafeWorkspaceVideoPath('clip.txt')).toBe(false)
  })

  it('streams bounded chunks into the app cache and reuses the cached file', async () => {
    const payload = new Uint8Array(1300).fill(7)
    const tools = fakeTools(payload)
    const progress: Array<{ loaded: number; total?: number }> = []
    const first = await downloadChatVideo(tools as never, 'session-1', video, {
      onProgress: (loaded, total) => progress.push({ loaded, ...(total === undefined ? {} : { total }) }),
    })
    expect(first.bytes).toBe(1300)
    expect(first.uri).toContain('file:///cache/chat-videos/')
    expect(tools.readBytes).toHaveBeenCalledTimes(1)
    expect(progress.at(-1)).toEqual({ loaded: 1300, total: 1300 })
    expect(cachedChatVideo('session-1', video)?.uri).toBe(first.uri)
    const calls = tools.readBytes.mock.calls.length
    const second = await downloadChatVideo(tools as never, 'session-1', video)
    expect(second.uri).toBe(first.uri)
    expect(tools.readBytes.mock.calls.length).toBe(calls)
  })

  it('rejects oversized videos and malformed chunks', async () => {
    const payload = new Uint8Array(16).fill(1)
    await expect(downloadChatVideo(fakeTools(payload, MAX_CHAT_VIDEO_BYTES + 1) as never, 's', video))
      .rejects.toMatchObject({ code: CHAT_VIDEO_TOO_LARGE })
    const tools = fakeTools(payload)
    tools.readBytes.mockResolvedValueOnce({ offset: 0, bytes: 16, data: 'not-base64!', eof: true })
    await expect(downloadChatVideo(tools as never, 's', video)).rejects.toMatchObject({ code: CHAT_VIDEO_INVALID })
  })

  it('rejects a video whose version changes while it is being read', async () => {
    const payload = new Uint8Array(1300).fill(3)
    const tools = fakeTools(payload)
    tools.statFile
      .mockResolvedValueOnce({ absolutePath: '/workspace/_scratch/videos/clip.mp4', version: 'v1', bytes: payload.length })
      .mockResolvedValueOnce({ absolutePath: '/workspace/_scratch/videos/clip.mp4', version: 'v2', bytes: payload.length })
    await expect(downloadChatVideo(tools as never, 's', video)).rejects.toMatchObject({ code: CHAT_VIDEO_CHANGED })
  })
})
