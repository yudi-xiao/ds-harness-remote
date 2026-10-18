import { describe, expect, it } from 'vitest'
import { AUTO_RECONNECT_DELAYS_MS, autoReconnectDelayMs, heartbeatIsStale } from '../src/state/reconnect-policy'

describe('remote carrier recovery policy', () => {
  it('backs off and saturates without giving up', () => {
    expect(AUTO_RECONNECT_DELAYS_MS).toEqual([2_000, 5_000, 10_000, 20_000, 30_000])
    expect(autoReconnectDelayMs(0)).toBe(2_000)
    expect(autoReconnectDelayMs(3)).toBe(20_000)
    expect(autoReconnectDelayMs(4)).toBe(30_000)
    expect(autoReconnectDelayMs(99)).toBe(30_000)
    expect(autoReconnectDelayMs(-1)).toBe(2_000)
  })

  it('detects a stale control heartbeat but accepts fresh or unknown samples', () => {
    const now = 1_000_000
    expect(heartbeatIsStale(undefined, now, 25_000)).toBe(false)
    expect(heartbeatIsStale(now - 20_000, now, 25_000)).toBe(false)
    // 25s interval => max(90s, 100s) threshold.
    expect(heartbeatIsStale(now - 99_999, now, 25_000)).toBe(false)
    expect(heartbeatIsStale(now - 100_001, now, 25_000)).toBe(true)
    // A slow heartbeat extends the threshold to four intervals.
    expect(heartbeatIsStale(now - 100_000, now, 60_000)).toBe(false)
    expect(heartbeatIsStale(now - 240_001, now, 60_000)).toBe(true)
  })
})
