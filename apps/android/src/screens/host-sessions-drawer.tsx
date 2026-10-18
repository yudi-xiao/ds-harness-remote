import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, SectionList, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Code2, Folder, FolderOpen, MessageSquare, Plus, Sparkles, RefreshCw } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAppStore } from '../state/store'
import type { AgentBackend, RemoteSession } from '../types'
import { strings } from '../locales/i18n'
import { IconButton } from '../ui/components'
import { radius, spacing, type } from '../ui/theme'
import { useTheme, type ThemeColors } from '../ui/theme-context'
import { useThemedStyles } from '../ui/use-themed-styles'
import { resolveSessionDisplayTitle } from './session-title'
import { getVisibleWorkspaceSessions } from '../lib/workspace-sessions'
import { loadHostSessionsDrawerGroups, saveHostSessionsDrawerGroup } from '../services/storage'

const SESSION_PAGE_SIZE = 3

export function HostSessionsDrawer({ onBack, onClose, onSelect, onNewSession, creating = false }: {
  onBack: () => void
  onClose: () => void
  onSelect: (session: RemoteSession) => Promise<void>
  onNewSession: (workspaceId?: string) => Promise<boolean>
  creating?: boolean
}) {
  // The store's catalog is scoped to selectedDevice and reset when changing hosts.
  const device = useAppStore(state => state.selectedDevice)
  const sessions = useAppStore(state => state.sessions)
  const lifecycles = useAppStore(state => state.sessionLifecycles)
  const selected = useAppStore(state => state.selectedSession)
  const archivedIds = useAppStore(state => state.archivedSessionIds)
  const workspaces = useAppStore(state => state.workspaces)
  const busy = useAppStore(state => state.busyAction)
  const error = useAppStore(state => state.error)
  const connected = useAppStore(state => state.connection.phase === 'connected')
  const refreshWorkspaces = useAppStore(state => state.refreshWorkspaces)
  const [refreshing, setRefreshing] = useState(false)
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<Record<string, number>>({})
  const deviceId = device?.deviceId
  const [groupsByDevice, setGroupsByDevice] = useState<Record<string, Record<string, boolean>>>({})
  const [storageErrors, setStorageErrors] = useState<Record<string, boolean>>({})
  const [loadedDeviceId, setLoadedDeviceId] = useState<string>()
  const groupsReady = deviceId === undefined || loadedDeviceId === deviceId
  const expandedGroups = deviceId === undefined ? {} : groupsByDevice[deviceId] ?? {}
  useEffect(() => {
    if (deviceId === undefined) return
    setLoadedDeviceId(undefined)
    let cancelled = false
    void loadHostSessionsDrawerGroups(deviceId).then(saved => {
      if (cancelled) return
      // Explicit user choices made while reading take precedence over hydration.
      setGroupsByDevice(current => ({ ...current, [deviceId]: { ...saved, ...current[deviceId] } }))
    }).catch(() => {
      if (!cancelled) setStorageErrors(current => ({ ...current, [deviceId]: true }))
    }).finally(() => {
      if (!cancelled) setLoadedDeviceId(deviceId)
    })
    return () => { cancelled = true }
  }, [deviceId])
  const toggleGroup = (key: string, expanded: boolean) => {
    if (deviceId === undefined) return
    setGroupsByDevice(current => ({ ...current, [deviceId]: { ...current[deviceId], [key]: expanded } }))
    // Keep a failure visible for this open drawer: later successful writes to
    // another group do not imply the failed choice was persisted.
    void saveHostSessionsDrawerGroup(deviceId, key, expanded).catch(() => {
      setStorageErrors(current => ({ ...current, [deviceId]: true }))
    })
  }
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const insets = useSafeAreaInsets()
  const groups = useMemo(() => {
    const archived = new Set(archivedIds)
    const assigned = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
    const grouped: Array<{ key: string; title: string; backend: AgentBackend; workspaceId?: string; sessions: RemoteSession[] }> = workspaces.map(workspace => ({
      key: `workspace:${workspace.backend ?? 'harness'}:${workspace.workspaceId}`,
      title: workspace.title,
      backend: workspace.backend ?? 'harness',
      workspaceId: workspace.workspaceId,
      sessions: getVisibleWorkspaceSessions(workspace, sessions, archivedIds).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    const unassigned = sessions.filter(session => !archived.has(session.sessionId) && !assigned.has(session.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (unassigned.length > 0) grouped.push({ key: 'unassigned', title: strings.chat.otherHostSessions, backend: 'harness', sessions: unassigned })
    return grouped
  }, [sessions, selected, archivedIds, workspaces, strings])
  const sections = groups.map(group => {
    const isWorkspace = group.key.startsWith('workspace:')
    const expanded = expandedGroups[group.key] ?? (isWorkspace || group.sessions.some(session => session.sessionId === selected?.sessionId))
    const visibleSessions = isWorkspace ? group.sessions.slice(0, visibleSessionCounts[group.key] ?? SESSION_PAGE_SIZE) : group.sessions
    return { ...group, expanded, data: expanded ? visibleSessions : [] }
  })
  const refresh = async () => {
    if (refreshing || busy !== undefined || !connected) return
    setRefreshing(true)
    try { await refreshWorkspaces() } finally { setRefreshing(false) }
  }

  return <Modal transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <View style={styles.overlay}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={strings.common.close} onPress={onClose} />
      <View accessibilityViewIsModal style={[styles.drawer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <IconButton label={strings.app.backToDevices} icon={ArrowLeft} onPress={onBack} />
          <Text style={styles.title} numberOfLines={1}>{device?.name}</Text>
          <IconButton label={strings.common.refresh} icon={RefreshCw} onPress={() => void refresh()} disabled={refreshing || busy !== undefined || !connected} />
        </View>
        {error !== undefined && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
        {deviceId !== undefined && storageErrors[deviceId] && <Text style={styles.error} accessibilityRole="alert">{strings.app.secureStorageUnavailable}</Text>}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.chat.newChat}
          accessibilityState={{ disabled: creating || busy !== undefined || refreshing || !connected }}
          disabled={creating || busy !== undefined || refreshing || !connected}
          onPress={() => void onNewSession()}
          style={({ pressed }) => [styles.newChatRow, pressed && styles.pressedRow, (creating || busy !== undefined || refreshing || !connected) && styles.newChatRowDisabled]}
        >
          <View style={styles.newChatIcon}>
            {creating ? <ActivityIndicator size="small" color={colors.primary} /> : <Plus size={18} color={colors.primary} />}
          </View>
          <View style={styles.copy}>
            <Text style={styles.newChatTitle}>{strings.chat.newChat}</Text>
            <Text style={styles.newChatHint}>{strings.chat.newChatUnassigned}</Text>
          </View>
        </Pressable>
        <SectionList
          sections={groupsReady ? sections : []}
          ListEmptyComponent={groupsReady ? null : <ActivityIndicator style={styles.loading} color={colors.muted} accessibilityLabel={strings.workspaces.loading} />}
          stickySectionHeadersEnabled={false}
          keyExtractor={session => session.sessionId}
          contentContainerStyle={styles.list}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          renderSectionFooter={({ section }) => {
            if (!section.expanded) return null
            if (section.key.startsWith('workspace:') && section.sessions.length === 0) {
              return <Text style={styles.emptyRunning}>{strings.workspaces.noSessions}</Text>
            }
            if (section.data.length === section.sessions.length) return null
            return <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${section.title} · ${strings.workspaces.showMoreSessions}`}
              accessibilityState={{ expanded: false }}
              onPress={() => setVisibleSessionCounts(current => ({ ...current, [section.key]: (current[section.key] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE }))}
              style={({ pressed }) => [styles.showMoreSessions, pressed && styles.pressedRow]}
            >
              <Text style={styles.showMoreSessionsText}>{strings.workspaces.showMoreSessions}</Text>
              <ChevronDown size={16} color={colors.muted} />
            </Pressable>
          }}
          renderSectionHeader={({ section }) => {
            const workspaceId = 'workspaceId' in section ? section.workspaceId : undefined
            const headerDisabled = creating || busy !== undefined || refreshing || !connected
            return <View style={styles.groupRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={section.expanded ? strings.workspaces.collapseWorkspace(section.title) : strings.workspaces.expandWorkspace(section.title)}
                accessibilityState={{ expanded: section.expanded }}
                onPress={() => toggleGroup(section.key, !section.expanded)}
                style={({ pressed }) => [styles.group, !section.expanded && styles.collapsedGroup, pressed && styles.pressedRow]}
              >
                <View style={styles.workspaceIcon}>
                  {section.backend === 'codex'
                    ? <Code2 size={18} color={colors.muted} />
                    : section.backend !== 'harness'
                      ? <Sparkles size={18} color={colors.muted} />
                      : section.expanded ? <FolderOpen size={18} color={colors.muted} /> : <Folder size={18} color={colors.muted} />}
                </View>
                <View style={styles.copy}>
                  <View style={styles.groupTitleRow}>
                    <Text style={styles.groupTitle} numberOfLines={1}>{section.title}</Text>
                    <Text style={styles.count}>{section.key.startsWith('workspace:') ? `${strings.workspaces[section.backend === 'harness' ? 'dsh' : section.backend]} · ` : ''}{section.sessions.length}</Text>
                  </View>
                </View>
                {section.expanded ? <ChevronDown size={16} color={colors.muted} /> : <ChevronRight size={16} color={colors.muted} />}
              </Pressable>
              {workspaceId !== undefined && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={strings.chat.newChatInWorkspace(section.title)}
                  accessibilityState={{ disabled: headerDisabled }}
                  disabled={headerDisabled}
                  onPress={() => void onNewSession(workspaceId)}
                  hitSlop={6}
                  style={({ pressed }) => [styles.newChatInGroup, pressed && styles.pressedRow]}
                >
                  <Plus size={18} color={headerDisabled ? colors.disabled : colors.primary} />
                </Pressable>
              )}
            </View>
          }}
          renderItem={({ item }) => {
            const active = item.sessionId === selected?.sessionId
            const running = lifecycles[item.sessionId]?.running ?? item.running
            const disabled = busy !== undefined || refreshing || !connected
            return <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled }}
              disabled={disabled}
              onPress={() => { if (active) onClose(); else void onSelect(item) }}
              style={({ pressed }) => [styles.row, active && styles.activeRow, pressed && styles.pressedRow]}
            >
              <View style={styles.sessionIcon}>
                {running
                  ? <ActivityIndicator size="small" color={active ? colors.white : colors.primary} />
                  : <MessageSquare size={16} color={active ? colors.white : colors.muted} />}
              </View>
              <View style={styles.copy}>
                <Text style={[styles.sessionTitle, active && styles.activeTitle]} numberOfLines={1}>{resolveSessionDisplayTitle(item) ?? strings.sessions.untitled}</Text>
              </View>
              {running && <Text style={[styles.runningStatus, active && styles.activeRunningStatus]} numberOfLines={1}>{strings.status.running}</Text>}
              {busy === `session:${item.sessionId}`
                ? <ActivityIndicator size="small" color={active ? colors.white : colors.primary} />
                : active ? <Check size={16} color={colors.white} /> : null}
            </Pressable>
          }}
        />
      </View>
    </View>
  </Modal>
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.scrim },
  drawer: { flex: 1, width: '88%', maxWidth: 420, backgroundColor: colors.surface },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  title: { ...type.heading, color: colors.ink, flex: 1, minWidth: 0, textAlign: 'center', paddingHorizontal: spacing.xs },
  list: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  loading: { paddingVertical: spacing.xl },
  newChatRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 52, marginTop: spacing.xs, marginHorizontal: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm },
  newChatRowDisabled: { opacity: 0.5 },
  newChatIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  newChatTitle: { ...type.smallStrong, color: colors.ink },
  newChatHint: { ...type.caption, color: colors.muted, marginTop: 1 },
  groupRow: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.xs, marginTop: spacing.xs },
  group: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs, paddingHorizontal: spacing.xs, minHeight: 48, borderRadius: radius.sm },
  collapsedGroup: { marginTop: 0 },
  newChatInGroup: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  workspaceIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  groupTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  groupTitle: { ...type.smallStrong, color: colors.ink, flex: 1 },
  count: { ...type.caption, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs, paddingHorizontal: spacing.xs, marginLeft: spacing.lg, minHeight: 48, borderRadius: radius.sm },
  showMoreSessions: { minHeight: 48, marginLeft: spacing.lg, paddingVertical: spacing.sm, paddingLeft: spacing.xs + 20 + spacing.xs, paddingRight: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderRadius: radius.sm },
  showMoreSessionsText: { ...type.small, color: colors.muted },
  sessionIcon: { width: 20, alignItems: 'center', justifyContent: 'center' },
  activeRow: { backgroundColor: colors.primary },
  pressedRow: { backgroundColor: colors.surfaceStrong },
  copy: { flex: 1, minWidth: 0 },
  sessionTitle: { ...type.small, color: colors.ink },
  activeTitle: { color: colors.white, fontWeight: '600' },
  runningStatus: { ...type.caption, color: colors.primary },
  activeRunningStatus: { color: colors.white },
  emptyRunning: { ...type.caption, color: colors.muted, paddingVertical: spacing.sm, paddingLeft: spacing.lg + spacing.xs + 20 + spacing.xs, paddingRight: spacing.xs },
  error: { ...type.small, color: colors.danger, padding: spacing.sm },
})
