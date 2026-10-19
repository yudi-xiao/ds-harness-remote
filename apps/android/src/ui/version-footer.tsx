import { useState } from 'react'
import * as Application from 'expo-application'
import * as Updates from 'expo-updates'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { strings } from '../locales/i18n'
import { radius, spacing, type } from './theme'
import type { ThemeColors } from './theme-context'
import { useTheme } from './theme-context'
import { useThemedStyles } from './use-themed-styles'

/** Short, stable-looking update id for the footer; the full id is in the dialog. */
function shortUpdateId(id: string | null): string | undefined {
  if (id === null || id.length === 0) return undefined
  const compact = id.replaceAll('-', '')
  return compact.length > 12 ? compact.slice(0, 12) : compact
}

function dateLabel(date: Date | null): string | undefined {
  if (date === null) return undefined
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function versionSummary(): { version: string; source: string; detail?: string } {
  const version = Application.nativeApplicationVersion ?? '0.7.0'
  const build = Application.nativeBuildVersion
  const base = build === null ? `v${version}` : `v${version} (${build})`
  if (!Updates.isEnabled) return { version: base, source: strings.version.embedded }
  if (Updates.isEmbeddedLaunch) return { version: base, source: strings.version.embedded }
  const id = shortUpdateId(Updates.updateId)
  const at = dateLabel(Updates.createdAt)
  return {
    version: base,
    source: id === undefined ? strings.version.ota : `${strings.version.ota} ${id}`,
    ...(at === undefined ? {} : { detail: `${strings.version.runtime} ${Updates.runtimeVersion ?? '—'} · ${at}` }),
  }
}

/**
 * Small footer identity shown on the first screen and the sign-in screen. It
 * makes the running bundle visible (embedded vs OTA + update id) and opens a
 * detailed version/update dialog with a manual OTA check.
 */
export function VersionFooter({ compact = false }: { compact?: boolean }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const [checking, setChecking] = useState(false)
  const summary = versionSummary()

  const checkForUpdate = async () => {
    if (checking) return
    if (!Updates.isEnabled) {
      Alert.alert(strings.version.title, strings.version.disabled)
      return
    }
    setChecking(true)
    try {
      const result = await Updates.checkForUpdateAsync()
      if (!result.isAvailable) {
        Alert.alert(strings.version.title, strings.version.upToDate)
        return
      }
      await Updates.fetchUpdateAsync()
      Alert.alert(strings.version.downloadedTitle, strings.version.downloadedBody, [
        { text: strings.common.cancel, style: 'cancel' },
        { text: strings.version.restart, onPress: () => void Updates.reloadAsync() },
      ])
    } catch {
      Alert.alert(strings.version.checkFailed, strings.version.checkFailedBody)
    } finally {
      setChecking(false)
    }
  }

  const showDetails = () => {
    const lines = [
      `${strings.version.appVersion}：${summary.version}`,
      `${strings.version.runtime}：${Updates.runtimeVersion ?? strings.common.unavailable}`,
      `${strings.version.channel}：${Updates.channel ?? strings.common.unavailable}`,
      `${strings.version.source}：${Updates.isEnabled
        ? Updates.isEmbeddedLaunch ? strings.version.embedded : strings.version.ota
        : strings.version.disabledShort}`,
      `${strings.version.updateId}：${Updates.updateId ?? strings.version.embeddedId}`,
      `${strings.version.updatedAt}：${dateLabel(Updates.createdAt) ?? strings.common.unavailable}`,
    ]
    Alert.alert(strings.version.title, lines.join('\n'), [
      { text: strings.common.close, style: 'cancel' },
      {
        text: checking ? strings.version.checking : strings.version.check,
        onPress: () => { void checkForUpdate() },
      },
    ])
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={strings.version.accessibility}
      onPress={showDetails}
      style={({ pressed }) => [styles.footer, compact && styles.compactFooter, pressed && styles.pressed]}
    >
      <Text style={styles.versionLine}>{summary.version} · {summary.source}</Text>
      {summary.detail !== undefined && <Text style={styles.detailLine}>{summary.detail}</Text>}
      {checking && <ActivityIndicator size="small" color={colors.muted} style={styles.spinner} />}
    </Pressable>
  )
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  footer: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  compactFooter: { paddingVertical: 2 },
  pressed: { opacity: 0.65 },
  versionLine: { ...type.caption, color: colors.muted, textAlign: 'center' },
  detailLine: { ...type.caption, color: colors.muted, textAlign: 'center', opacity: 0.8, marginTop: 1 },
  spinner: { marginTop: 2 },
})
