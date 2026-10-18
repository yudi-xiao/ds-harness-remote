/**
 * Recovery policy for the Remote carrier. Kept pure so the state machine can be
 * tested without timers or a live transport.
 */
export const AUTO_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const

/** Delay before the next automatic reconnect; saturated at 30s for long outages. */
export function autoReconnectDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) return AUTO_RECONNECT_DELAYS_MS[0] ?? 2_000
  return AUTO_RECONNECT_DELAYS_MS[Math.min(attempt, AUTO_RECONNECT_DELAYS_MS.length - 1)] ?? 30_000
}

/**
 * True when the server's control heartbeat has gone silent long enough that the
 * carrier is likely a half-open socket. The Worker closes a peer after 75s of
 * silence; this allows one extra interval before the client recovers itself.
 */
export function heartbeatIsStale(
  lastControlReceivedAt: number | undefined,
  now: number,
  heartbeatIntervalMs: number | undefined,
): boolean {
  if (typeof lastControlReceivedAt !== 'number' || !Number.isFinite(lastControlReceivedAt) || lastControlReceivedAt <= 0) return false
  const interval = typeof heartbeatIntervalMs === 'number' && Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
    ? heartbeatIntervalMs
    : 25_000
  return now - lastControlReceivedAt > Math.max(90_000, interval * 4)
}
