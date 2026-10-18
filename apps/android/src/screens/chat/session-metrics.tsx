import { ChevronRight, Gauge, ShieldCheck, Zap } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { strings } from '../../locales/i18n'
import { hasSessionMetrics, formatPercent, type SessionMetrics } from '../../state/session-metrics'
import { spacing } from '../../ui/theme'
import type { ThemeColors } from '../../ui/theme-context'
import { useTheme } from '../../ui/theme-context'
import { useThemedStyles } from '../../ui/use-themed-styles'
import { permissionDisplayName } from './pickers'

/**
 * Compact, always-visible session meter under the conversation title. The
 * values come from the official `tokenUsage` / `contextPressure` /
 * `permissions` projections, so they update live with each step instead of
 * being sampled locally by the app.
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
        <Gauge size={12} color={hot ? colors.warning : colors.muted} />
        <Text style={[styles.text, hot && { color: colors.warning }]}>{strings.chat.contextShort} {context}</Text>
      </>}
      {cache !== undefined && <>
        <View style={styles.dot} />
        <Zap size={12} color={colors.muted} />
        <Text style={styles.text}>{strings.chat.cacheShort} {cache}</Text>
      </>}
      {permission !== undefined && <>
        <View style={styles.dot} />
        <ShieldCheck size={12} color={dangerous ? colors.warning : colors.muted} />
        <Text style={[styles.text, dangerous && { color: colors.warning }]} numberOfLines={1}>{permission}</Text>
      </>}
      <ChevronRight size={12} color={colors.muted} />
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
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xs,
  },
  pressed: { opacity: 0.6 },
  text: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  dot: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.muted, opacity: 0.6, marginHorizontal: 2 },
})
