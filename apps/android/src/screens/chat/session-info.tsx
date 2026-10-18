import { X } from 'lucide-react-native'
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { strings } from '../../locales/i18n'
import { formatExactPercent, formatPercent, formatTokenCount, hasSessionMetrics, sessionMetrics } from '../../state/session-metrics'
import { useAppStore } from '../../state/store'
import type { RemoteSession, WorkspaceView } from '../../types'
import { IconButton, KeyValue, SectionTitle } from '../../ui/components'
import { spacing, type } from '../../ui/theme'
import type { ThemeColors } from '../../ui/theme-context'
import { useThemedStyles } from '../../ui/use-themed-styles'
import { DeviceConnectionInfo } from '../device-screens'
import { ModalSurface, usePickerListMaxHeight } from './modal'
import { permissionDisplayName } from './pickers'
import { sessionTitle } from './presentation'

export function SessionInfo({ session, workspace, onClose, onOpenWorkspace }: {
  session: RemoteSession
  workspace?: WorkspaceView
  onClose: () => void
  onOpenWorkspace: () => void
}) {
  const device = useAppStore(state => state.selectedDevice)
  const styles = useThemedStyles(createStyles)
  const insets = useSafeAreaInsets()
  const maxHeight = usePickerListMaxHeight()
  const backend = workspace?.backend ?? session.backend ?? 'harness'
  const metrics = sessionMetrics(session)
  const contextPercent = formatPercent(metrics.contextPercent)
  const contextUsed = formatTokenCount(metrics.contextUsedTokens)
  const contextWindow = formatTokenCount(metrics.contextWindow)
  const contextValue = contextUsed === undefined
    ? undefined
    : [contextWindow === undefined ? contextUsed : `${contextUsed} / ${contextWindow}`, contextPercent === undefined ? undefined : `(${contextPercent})`].filter(Boolean).join(' ')
  const breakdownValue = [
    metrics.contextSystemTokens === undefined ? undefined : `${strings.sessionInfo.system} ${formatTokenCount(metrics.contextSystemTokens)}`,
    metrics.contextToolsTokens === undefined ? undefined : `${strings.sessionInfo.tools} ${formatTokenCount(metrics.contextToolsTokens)}`,
    metrics.contextMessageTokens === undefined ? undefined : `${strings.sessionInfo.messages} ${formatTokenCount(metrics.contextMessageTokens)}`,
  ].filter((item): item is string => item !== undefined).join(' · ') || undefined
  const tokenValue = [
    metrics.uncachedInputTokens === undefined ? undefined : `${strings.sessionInfo.tokenInput} ${formatTokenCount(metrics.uncachedInputTokens)}`,
    metrics.outputTokens === undefined ? undefined : `${strings.sessionInfo.tokenOutput} ${formatTokenCount(metrics.outputTokens)}`,
  ].filter((item): item is string => item !== undefined).join(' · ') || undefined
  const cacheValue = [
    metrics.cacheReadTokens === undefined ? undefined : `${strings.sessionInfo.cacheRead} ${formatTokenCount(metrics.cacheReadTokens)}`,
    metrics.cacheWriteTokens === undefined ? undefined : `${strings.sessionInfo.cacheWrite} ${formatTokenCount(metrics.cacheWriteTokens)}`,
  ].filter((item): item is string => item !== undefined).join(' · ') || undefined
  const permissionValue = metrics.permissionPreset === undefined
    ? metrics.sandboxMode === undefined ? undefined : permissionDisplayName(metrics.sandboxMode)
    : (() => {
        const label = permissionDisplayName(metrics.permissionPreset!)
        return label === metrics.permissionPreset ? label : `${label} (${metrics.permissionPreset})`
      })()
  const modelValue = [metrics.model, metrics.provider].filter((item): item is string => item !== undefined && item.length > 0).join(' · ') || undefined
  const totalCacheHit = formatExactPercent(metrics.cacheHitPercent)
  const lastCacheHit = formatExactPercent(metrics.lastCacheHitPercent)

  return <Modal transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <ModalSurface onClose={onClose}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>{strings.sessionInfo.title}</Text>
        <IconButton label={strings.common.close} icon={X} onPress={onClose} />
      </View>
      <ScrollView style={{ flexShrink: 1, maxHeight }} contentContainerStyle={{ paddingBottom: insets.bottom }}>
        <Text selectable style={styles.sessionTitle}>{sessionTitle(session)}</Text>
        {hasSessionMetrics(metrics) && <>
          <SectionTitle>{strings.sessionInfo.usage}</SectionTitle>
          {contextValue !== undefined && <KeyValue label={strings.sessionInfo.contextUsage} value={contextValue} />}
          {breakdownValue !== undefined && <KeyValue label={strings.sessionInfo.contextBreakdown} value={breakdownValue} />}
          {totalCacheHit !== undefined && <KeyValue label={strings.sessionInfo.cacheHitTotal} value={totalCacheHit} />}
          {lastCacheHit !== undefined && <KeyValue label={strings.sessionInfo.cacheHitLast} value={lastCacheHit} />}
          {tokenValue !== undefined && <KeyValue label={strings.sessionInfo.tokens} value={tokenValue} />}
          {cacheValue !== undefined && <KeyValue label={strings.sessionInfo.cacheTokens} value={cacheValue} />}
          {permissionValue !== undefined && <KeyValue label={strings.sessionInfo.permissionLevel} value={permissionValue} />}
          {metrics.sandboxMode !== undefined && <KeyValue label={strings.sessionInfo.sandboxMode} value={metrics.sandboxMode} mono />}
          {metrics.approvalMode !== undefined && <KeyValue label={strings.sessionInfo.approvalMode} value={metrics.approvalMode} mono />}
          {modelValue !== undefined && <KeyValue label={strings.sessionInfo.model} value={modelValue} />}
        </>}
        <SectionTitle>{strings.sessionInfo.workspaceInfo}</SectionTitle>
        <KeyValue label={strings.workspaces.title} value={workspace?.title ?? strings.chat.workspaceNone} onPress={onOpenWorkspace} />
        <KeyValue label={strings.sessionInfo.host} value={device?.name ?? strings.common.unavailable} />
        <KeyValue label={strings.workspaces.type} value={strings.workspaces[backend === 'harness' ? 'dsh' : backend]} />
        <KeyValue label={strings.sessionInfo.workspaceDirectory} value={workspace?.path ?? strings.common.unavailable} mono />
        {session.cwd !== undefined && session.cwd !== workspace?.path && <KeyValue label={strings.sessionInfo.sessionDirectory} value={session.cwd} mono />}
        {workspace !== undefined && <KeyValue label={strings.devices.conversations} value={workspace.sessionIds.length.toLocaleString()} />}
        <DeviceConnectionInfo deviceId={device?.deviceId} />
      </ScrollView>
    </ModalSurface>
  </Modal>
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  title: { ...type.heading, color: colors.ink, flex: 1 },
  sessionTitle: { ...type.bodyStrong, color: colors.ink },
})
