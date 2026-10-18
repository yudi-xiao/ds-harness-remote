import { ChevronRight, Gauge, ShieldCheck, Zap } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { strings } from '../../locales/i18n'
import { hasSessionMetrics, formatPercent, type SessionMetrics } from '../../state/session-metrics'
import { radius, spacing } from '../../ui/theme'
import type { ThemeColors } from '../../ui/theme-context'
import { useTheme } from '../../ui/theme-context'
import { useThemedStyles } from '../../ui/use-themed-styles'
import { permissionDisplayName } from './pickers'

/**
 * Compact session meter shown directly above the composer. It lives in the
 * opaque composer surface (never inside the translucent chat header), so it
 * cannot overlap the conversation text. Values come from the official
 * `tokenUsage` / `contextPressure` / `permissions` projections.
 */
export function SessionMetricsBar({ metrics, onPress }: { metrics: SessionMetrics; onPress: () => void }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  if (!hasSessionMetrics(metrics)) return null

  const context = formatPercent(metrics.contextPercent) ?? compact(metrics.contextUsedTokens)
  // Hide a misleading 0% when the provider does not report prompt caching at
  // all (for example some local llama.cpp builds).
  const cache = metrics.cacheReadTokens === undefined || metrics.cacheReadTokens === 0
    ? undefined
    : formatPercent(metrics.cacheHitPercent)
  const permission = metrics.permissionPreset === undefined
    ? metrics.sandboxMode === undefined ? undefined : permissionDisplayName(metrics.sandboxMode)
    : permissionDisplayName(metrics.permissionPreset)
  const dangerous = permission !== undefined && (metrics.permissionPreset === 'danger-full-access' || metrics.sandboxMode === 'danger-full-access')
  const hot = metrics.contextPercent !== undefined && metrics.contextPercent >= 85
  const label = [
    context === undefined ? undefined : `${strings.sessionInfo.contextUsage}: ${context}`,
    cache === undefined ? undefined : `${strings.sessionInfo.cacheHitTotal}: ${cache}`,
    permission === undefined ? undefined : `${strings.sessionInfo.permissionLevel}: ${permission}`,
  ].filter((item): item is string => item !== undefined).join(' · ')

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${strings.sessionInfo.usage}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {context !== undefined && <>
        <Gauge size={13} color={hot ? colors.warning : colors.muted} />
        <Text style={[styles.text, hot && { color: colors.warning }]}>{strings.chat.contextShort} {context}</Text>
      </>}
      {cache !== undefined && <>
        <View style={styles.dot} />
        <Zap size={13} color={colors.muted} />
        <Text style={styles.text}>{strings.chat.cacheShort} {cache}</Text>
      </>}
      {permission !== undefined && <>
        <View style={styles.dot} />
        <ShieldCheck size={13} color={dangerous ? colors.warning : colors.muted} />
        <Text style={[styles.text, dangerous && { color: colors.warning }]} numberOfLines={1}>{permission}</Text>
      </>}
      <ChevronRight size={13} color={colors.muted} />
    </Pressable>
  )
}

function compact(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  row: {
    alignSelf: 'center',
    maxWidth: '100%',
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    backgroundColor: colors.surfaceStrong,
  },
  pressed: { opacity: 0.6 },
  text: { color: colors.muted, fontSize: 11, lineHeight: 16, flexShrink: 1 },
  dot: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.muted, opacity: 0.6, marginHorizontal: 2 },
})
