import type { RemoteSession } from '../types'

/**
 * Session usage projected by the official token-meter plugin. All fields are
 * optional: older Hosts, ACP backends, and models that do not report prompt
 * caching simply omit them, and the UI degrades to the fields it has.
 */
export interface SessionMetrics {
  contextUsedTokens?: number
  contextWindow?: number
  contextPercent?: number
  contextSystemTokens?: number
  contextToolsTokens?: number
  contextMessageTokens?: number
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheHitPercent?: number
  lastCacheHitPercent?: number
  lastUncachedInputTokens?: number
  lastOutputTokens?: number
  lastCacheReadTokens?: number
  lastCacheWriteTokens?: number
  permissionPreset?: string
  sandboxMode?: string
  approvalMode?: string
  provider?: string
  model?: string
}

export function sessionMetrics(session: RemoteSession | undefined): SessionMetrics {
  const values = record(session?.projections?.values)
  if (values === undefined) return {}
  const pressure = projectionRecord(values.contextPressure)
  const usage = projectionRecord(values.tokenUsage)
  const totals = projectionRecord(usage?.totals) ?? usage
  const last = projectionRecord(usage?.last)
  const buckets = projectionRecord(last?.buckets) ?? last
  const breakdownProjection = projectionRecord(values.contextBreakdown)
  const breakdown = record(breakdownProjection?.breakdown) ?? breakdownProjection
  const permissions = projectionRecord(values.permissions)
  const selection = projectionRecord(values.modelSelection)
  const lastUsed = record(selection?.lastUsed)

  const uncachedInputTokens = count(totals?.uncachedInputTokens)
  const outputTokens = count(totals?.outputTokens)
  const cacheReadTokens = count(totals?.cacheReadTokens)
  const cacheWriteTokens = count(totals?.cacheWriteTokens)
  const contextWindow = count(pressure?.contextWindow)
  const contextUsedTokens = count(pressure?.projectedTokens)
    ?? count(pressure?.pressureTokens)
    ?? count(pressure?.surfaceTokens)
  const contextSystemTokens = count(breakdown?.systemTokens)
  const contextToolsTokens = count(breakdown?.toolsTokens)
  const contextMessageTokens = count(breakdown?.messageTokens)
  const lastUncachedInputTokens = count(buckets?.uncachedInputTokens)
  const lastOutputTokens = count(buckets?.outputTokens)
  const lastCacheReadTokens = count(buckets?.cacheReadTokens)
  const lastCacheWriteTokens = count(buckets?.cacheWriteTokens)
  const cacheHitPercent = ratioPercent(uncachedInputTokens, cacheReadTokens, cacheWriteTokens)
  const lastCacheHitPercent = ratioPercent(lastUncachedInputTokens, lastCacheReadTokens, lastCacheWriteTokens)
  const permissionPreset = firstString(permissions?.preset, permissions?.currentValue)
  const sandboxMode = firstString(permissions?.sandbox, values.sandboxMode)
  const approvalMode = firstString(permissions?.approval)
  const provider = firstString(lastUsed?.provider)
  const model = firstString(lastUsed?.model)

  return {
    ...(contextUsedTokens === undefined ? {} : { contextUsedTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(contextUsedTokens === undefined || contextWindow === undefined || contextWindow <= 0
      ? {}
      : { contextPercent: clampPercent(contextUsedTokens / contextWindow * 100) }),
    ...(contextSystemTokens === undefined ? {} : { contextSystemTokens }),
    ...(contextToolsTokens === undefined ? {} : { contextToolsTokens }),
    ...(contextMessageTokens === undefined ? {} : { contextMessageTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }),
    ...(lastCacheHitPercent === undefined ? {} : { lastCacheHitPercent }),
    ...(lastUncachedInputTokens === undefined ? {} : { lastUncachedInputTokens }),
    ...(lastOutputTokens === undefined ? {} : { lastOutputTokens }),
    ...(lastCacheReadTokens === undefined ? {} : { lastCacheReadTokens }),
    ...(lastCacheWriteTokens === undefined ? {} : { lastCacheWriteTokens }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    ...(approvalMode === undefined ? {} : { approvalMode }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

/** Whether the session exposes any metric worth rendering. */
export function hasSessionMetrics(metrics: SessionMetrics): boolean {
  return metrics.contextPercent !== undefined
    || metrics.contextUsedTokens !== undefined
    || metrics.cacheHitPercent !== undefined
    || metrics.permissionPreset !== undefined
    || metrics.sandboxMode !== undefined
}

/** 267686 -> "267.7K", 1048576 -> "1.0M", 481310 -> "481.3K". */
export function formatTokenCount(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  if (value >= 1_000_000) return `${trimZero((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`
  if (value >= 1_000) return `${trimZero((value / 1_000).toFixed(1))}K`
  return value.toLocaleString()
}

export function formatPercent(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const clamped = clampPercent(value)
  if (clamped > 0 && clamped < 1) return '<1%'
  return `${Math.round(clamped)}%`
}

export function formatExactPercent(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const clamped = clampPercent(value)
  if (clamped > 0 && clamped < 0.1) return '<0.1%'
  return `${clamped.toFixed(clamped >= 99.95 ? 0 : 1)}%`
}

function projectionRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value)
  if (direct === undefined) return undefined
  // Defensive: some Hosts wrap projection rows in `{ ver, seq, val }` while the
  // live session API returns the unwrapped value.
  if (record(direct.val) !== undefined && (typeof direct.ver === 'number' || typeof direct.seq === 'number')) return record(direct.val)
  return direct
}

function ratioPercent(uncached: number | undefined, cacheRead: number | undefined, cacheWrite: number | undefined): number | undefined {
  const prompt = (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  if (prompt <= 0 || cacheRead === undefined) return undefined
  return cacheRead / prompt * 100
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
