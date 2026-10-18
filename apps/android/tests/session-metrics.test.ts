import { describe, expect, it } from 'vitest'
import { formatExactPercent, formatPercent, formatTokenCount, sessionMetrics } from '../src/state/session-metrics'
import type { RemoteSession } from '../src/types'

function session(values: Record<string, unknown>): RemoteSession {
  return { sessionId: 'session-1', backend: 'harness', projections: { values } } as unknown as RemoteSession
}

describe('session metrics projections', () => {
  it('projects context, cache, token and permission values from the remote projections', () => {
    const metrics = sessionMetrics(session({
      tokenUsage: { uncachedInputTokens: 2_627_679, outputTokens: 481_310, cacheReadTokens: 335_456_640, cacheWriteTokens: 0 },
      contextPressure: { pressureTokens: 248_573, projectedTokens: 267_686, contextWindow: 1_048_576 },
      contextBreakdown: { systemTokens: 2_149, toolsTokens: 10_574, messageTokens: 179_458 },
      permissions: { currentValue: 'danger-full-access' },
      modelSelection: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    }))

    expect(metrics.contextUsedTokens).toBe(267_686)
    expect(metrics.contextPercent).toBeCloseTo(25.5, 1)
    expect(metrics.contextSystemTokens).toBe(2_149)
    expect(metrics.contextToolsTokens).toBe(10_574)
    expect(metrics.contextMessageTokens).toBe(179_458)
    expect(metrics.cacheHitPercent).toBeCloseTo(99.2, 1)
    expect(metrics.uncachedInputTokens).toBe(2_627_679)
    expect(metrics.permissionPreset).toBe('danger-full-access')
    expect(metrics.provider).toBe('deepseek-account')
    expect(metrics.model).toBe('deepseek-flash')
    expect(formatTokenCount(metrics.contextUsedTokens)).toBe('267.7K')
    expect(formatTokenCount(metrics.contextWindow)).toBe('1M')
    expect(formatPercent(metrics.contextPercent)).toBe('26%')
    expect(formatExactPercent(metrics.cacheHitPercent)).toBe('99.2%')
  })

  it('keeps reports without token-meter projections limited to permissions', () => {
    const metrics = sessionMetrics(session({ permissions: { currentValue: 'workspace-write' } }))
    expect(metrics.permissionPreset).toBe('workspace-write')
    expect(metrics.contextPercent).toBeUndefined()
    expect(metrics.cacheHitPercent).toBeUndefined()
  })

  it('accepts wrapped projection rows from the persisted cache shape', () => {
    const metrics = sessionMetrics(session({
      contextPressure: { ver: 5, seq: 10, val: { pressureTokens: 100, contextWindow: 1_000 } },
      tokenUsage: { ver: 2, seq: 10, val: { totals: { uncachedInputTokens: 50, outputTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 0 } } },
    }))
    expect(metrics.contextPercent).toBe(10)
    expect(metrics.cacheHitPercent).toBe(50)
  })
})
