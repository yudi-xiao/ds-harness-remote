import { useState } from 'react'
import * as Updates from 'expo-updates'
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Check, ChevronRight, KeyRound, Laptop, LockKeyhole, RotateCcw, Settings, type LucideIcon } from 'lucide-react-native'
import { APP_NAME, APP_PROTOCOL_LABEL } from '../brand'
import { useAppStore } from '../state/store'
import { BlurHeaderFrame, Button, Field, KeyValue, Screen, TopBar } from '../ui/components'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { transportPreferenceOptions } from '../types'
import type { DefaultPermissionPreset, LoginMethod } from '../types'
import { radius, spacing, type } from '../ui/theme'
import { useTheme, type ThemeColors } from '../ui/theme-context'
import { useResponsiveLayout } from '../ui/responsive'
import { useThemedStyles } from '../ui/use-themed-styles'
import { strings as zhCN, type LanguagePreference } from '../locales/i18n'
import { appVersionLabel } from '../lib/app-version'
import type { ThemePreference } from '../ui/theme'

/** Personal DSH Remote Server; a build can override it via EXPO_PUBLIC_DSH_REMOTE_SERVER. */
const defaultServerUrl = 'https://remote-dsh.howlearnwood.com'

type SetupLoginMethod = Extract<LoginMethod, 'oauth' | 'github-oauth' | 'password'>

function loginMethodLabel(method?: LoginMethod): string {
  if (method === 'oauth') return zhCN.setup.oauth
  if (method === 'github-oauth') return zhCN.setup.githubOAuth
  if (method === 'password') return zhCN.setup.passwordMethod
  return zhCN.common.unknown
}

export function ServerSetupScreen({ onComplete, onBack }: { onComplete: () => void; onBack?: () => void }) {
  const config = useAppStore(state => state.config)
  const busy = useAppStore(state => state.busyAction === 'server')
  const oauthBusy = useAppStore(state => state.busyAction === 'oauth')
  const configure = useAppStore(state => state.configureServer)
  const startOAuth = useAppStore(state => state.startOAuth)
  const startGithubOAuth = useAppStore(state => state.startGithubOAuth)
  const [serverUrl, setServerUrl] = useState(config?.baseUrl ?? process.env.EXPO_PUBLIC_DSH_REMOTE_SERVER ?? defaultServerUrl)
  const [email, setEmail] = useState(process.env.EXPO_PUBLIC_DSH_REMOTE_ACCOUNT ?? '')
  const [password, setPassword] = useState('')
  const [loginMethod, setLoginMethod] = useState<SetupLoginMethod>('oauth')
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)

  const submit = async () => {
    if (await configure(serverUrl, email, password)) onComplete()
  }

  const signInWithZhihu = async () => {
    const url = await startOAuth(serverUrl)
    if (url !== undefined) await Linking.openURL(url)
  }

  const signInWithGithub = async () => {
    const url = await startGithubOAuth(serverUrl)
    if (url !== undefined) await Linking.openURL(url)
  }

  const canSubmit = email.trim().length > 0 && password.length > 0

  return (
    <View style={styles.flex}>
      <BlurHeaderFrame header={<TopBar title={zhCN.setup.title} onBack={onBack} />}>
        <Screen>
          <Text style={styles.productName}>{APP_NAME}</Text>
          <Text style={styles.title}>{config === undefined ? zhCN.setup.signIn : zhCN.setup.signInAgain}</Text>
          <Text style={styles.lead}>{zhCN.setup.lead}</Text>

          <View style={styles.form}>
            <View style={styles.methodTabs}>
              <Pressable accessibilityRole="tab" accessibilityState={{ selected: loginMethod === 'oauth' }} onPress={() => setLoginMethod('oauth')} style={[styles.methodTab, loginMethod === 'oauth' && styles.methodTabActive]}>
                <Text style={[styles.methodTabText, loginMethod === 'oauth' && styles.methodTabTextActive]}>{zhCN.setup.oauth}</Text>
              </Pressable>
              <Pressable accessibilityRole="tab" accessibilityState={{ selected: loginMethod === 'github-oauth' }} onPress={() => setLoginMethod('github-oauth')} style={[styles.methodTab, loginMethod === 'github-oauth' && styles.methodTabActive]}>
                <Text style={[styles.methodTabText, loginMethod === 'github-oauth' && styles.methodTabTextActive]}>{zhCN.setup.githubOAuth}</Text>
              </Pressable>
              <Pressable accessibilityRole="tab" accessibilityState={{ selected: loginMethod === 'password' }} onPress={() => setLoginMethod('password')} style={[styles.methodTab, loginMethod === 'password' && styles.methodTabActive]}>
                <Text style={[styles.methodTabText, loginMethod === 'password' && styles.methodTabTextActive]}>{zhCN.setup.passwordMethod}</Text>
              </Pressable>
            </View>

            {loginMethod === 'oauth'
              ? <>
                  <Button label={zhCN.setup.zhihu} onPress={() => void signInWithZhihu()} loading={oauthBusy} />
                  <Text style={styles.oauthHint}>{zhCN.setup.oauthHint}</Text>
                </>
              : loginMethod === 'github-oauth'
                ? <>
                    <Button label={zhCN.setup.github} onPress={() => void signInWithGithub()} loading={oauthBusy} />
                    <Text style={styles.oauthHint}>{zhCN.setup.oauthHint}</Text>
                  </>
                : <>
                  <Field label={zhCN.setup.email} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" placeholder={zhCN.setup.emailPlaceholder} />
                  <Field label={zhCN.setup.password} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" returnKeyType="go" onSubmitEditing={() => { if (canSubmit) void submit() }} placeholder={zhCN.setup.passwordPlaceholder} hint={zhCN.setup.passwordHint} />
                  <Button label={zhCN.setup.title} onPress={() => void submit()} loading={busy} disabled={!canSubmit} />
                </>}

            <View style={styles.serverSection}>
              <Field label={zhCN.setup.server} value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" hint={zhCN.setup.serverHint} placeholder="https://remote.example.com" />
            </View>
          </View>

          <View style={styles.securityNote}>
            <LockKeyhole size={20} color={colors.primary} />
            <View style={styles.securityCopy}>
              <Text style={styles.securityTitle}>{zhCN.setup.trustTitle}</Text>
              <Text style={styles.securityBody}>{zhCN.setup.trustBody}</Text>
            </View>
          </View>
          <Text style={styles.versionText}>{appVersionLabel()}</Text>
        </Screen>
      </BlurHeaderFrame>
    </View>
  )
}

export function SettingsScreen({ onBack, onReset }: { onBack: () => void; onReset: () => void }) {
  const config = useAppStore(state => state.config)
  const identity = useAppStore(state => state.identity)
  const account = useAppStore(state => state.account)
  const preference = useAppStore(state => state.transportPreference)
  const setPreference = useAppStore(state => state.setTransportPreference)
  const languagePreference = useAppStore(state => state.languagePreference)
  const setLanguagePreference = useAppStore(state => state.setLanguagePreference)
  const themePreference = useAppStore(state => state.themePreference)
  const setThemePreference = useAppStore(state => state.setThemePreference)
  const defaultPermission = useAppStore(state => state.defaultPermissionPreset)
  const setDefaultPermission = useAppStore(state => state.setDefaultPermissionPreset)
  const [permissionSaving, setPermissionSaving] = useState(false)
  const reset = useAppStore(state => state.resetLocalData)
  const signOut = useAppStore(state => state.signOut)
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  // Cap the read-only info column on wide landscape tablets; phone portrait
  // already fits inside contentMaxWidth, so nothing changes there.
  const { contentMaxWidth, landscape } = useResponsiveLayout()

  const pickDefaultPermission = (preset: DefaultPermissionPreset) => {
    if (permissionSaving || preset === defaultPermission) return
    const save = async () => {
      setPermissionSaving(true)
      try {
        await setDefaultPermission(preset)
      } catch {
        Alert.alert(zhCN.settings.defaultPermissionSaveFailed, zhCN.settings.defaultPermissionSaveFailedBody)
      } finally {
        setPermissionSaving(false)
      }
    }
    if (preset === 'danger-full-access') {
      Alert.alert(zhCN.settings.defaultPermissionFullAccessTitle, zhCN.settings.defaultPermissionFullAccessBody, [
        { text: zhCN.common.cancel, style: 'cancel' },
        { text: zhCN.chat.enable, style: 'destructive', onPress: () => void save() },
      ])
    } else void save()
  }

  const confirmReset = () => Alert.alert(
    zhCN.settings.resetTitle,
    zhCN.settings.resetBody,
    [
      { text: zhCN.common.cancel, style: 'cancel' },
      { text: zhCN.settings.reset, style: 'destructive', onPress: () => void reset().then(onReset) },
    ],
  )

  const confirmSignOut = () => Alert.alert(
    zhCN.settings.signOutTitle,
    zhCN.settings.signOutBody,
    [
      { text: zhCN.common.cancel, style: 'cancel' },
      { text: zhCN.settings.signOut, style: 'destructive', onPress: () => void signOut().then(onReset) },
    ],
  )

  return (
    <View style={styles.flex}>
      <BlurHeaderFrame header={<TopBar title={zhCN.settings.title} onBack={onBack} />}>
        <Screen>
          <View style={[styles.contentColumn, landscape && { maxWidth: contentMaxWidth }]}>
            <View style={styles.settingsHeader}>
              <View style={styles.settingsIcon}><Settings size={25} color={colors.primary} /></View>
              <View style={styles.securityCopy}><Text style={styles.settingsTitle}>{zhCN.settings.thisPhone}</Text><Text style={styles.settingsSubtitle}>{identity?.name ?? zhCN.settings.androidDevice}</Text></View>
            </View>

            <Text style={styles.groupLabel}>{zhCN.settings.language}</Text>
            <View style={styles.preferenceList}>
              {languageOptions().map(option => {
                const chosen = option.value === languagePreference
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: chosen }}
                    onPress={() => void setLanguagePreference(option.value)}
                    style={[styles.preferenceOption, chosen && styles.preferenceOptionChosen]}
                  >
                    <Text style={[styles.preferenceName, styles.languageName]}>{option.name}</Text>
                    {chosen && <Check size={17} color={colors.primary} />}
                  </Pressable>
                )
              })}
              <Text style={styles.preferenceNote}>{zhCN.settings.languageNote}</Text>
            </View>

            <Text style={styles.groupLabel}>{zhCN.settings.theme}</Text>
            <View style={styles.segmentRow} accessibilityRole="tablist">
              {themeOptions().map(option => {
                const chosen = option.value === themePreference
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: chosen }}
                    onPress={() => void setThemePreference(option.value)}
                    style={[styles.segmentButton, chosen && styles.segmentButtonActive]}
                  >
                    <Text style={[styles.segmentButtonText, chosen && styles.segmentButtonTextActive]} numberOfLines={1}>
                      {option.name}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            <Text style={styles.groupLabel}>{zhCN.settings.defaultPermission}</Text>
            <View style={styles.preferenceList} accessibilityRole="radiogroup">
              {([
                { value: 'default', name: zhCN.settings.defaultPermissionHost, description: zhCN.settings.defaultPermissionHostDescription },
                { value: 'workspace-write', name: zhCN.chat.permissionWorkspaceWrite, description: zhCN.chat.permissionWorkspaceWriteDescription },
                { value: 'danger-full-access', name: zhCN.chat.permissionFullAccess, description: zhCN.chat.permissionFullAccessDescription },
              ] satisfies Array<{ value: DefaultPermissionPreset; name: string; description: string }>).map(option => {
                const chosen = option.value === defaultPermission
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: chosen, disabled: permissionSaving }}
                    disabled={permissionSaving}
                    onPress={() => pickDefaultPermission(option.value)}
                    style={[styles.preferenceOption, styles.permissionOption, chosen && styles.preferenceOptionChosen]}
                  >
                    <View style={styles.preferenceCopy}>
                      <Text style={styles.preferenceName}>{option.name}</Text>
                      <Text style={styles.preferenceDescription}>{option.description}</Text>
                    </View>
                    {chosen && <Check size={17} color={colors.primary} />}
                  </Pressable>
                )
              })}
              <Text style={styles.preferenceNote}>{zhCN.settings.defaultPermissionNote}</Text>
            </View>

            <Text style={styles.groupLabel}>{zhCN.settings.connection}</Text>
            <View style={styles.group}>
              <KeyValue label={zhCN.settings.server} value={config?.baseUrl ?? zhCN.settings.notConfigured} />
              <KeyValue label={zhCN.settings.account} value={account ?? zhCN.settings.notSignedIn} />
              <KeyValue label={zhCN.settings.loginMethod} value={loginMethodLabel(config?.loginMethod)} />
              <KeyValue label={zhCN.settings.protocol} value={APP_PROTOCOL_LABEL} />
            </View>

            <Text style={styles.groupLabel}>{zhCN.settings.transport}</Text>
            <View style={styles.preferenceList}>
              {transportPreferenceOptions().map(option => {
                const chosen = option.value === preference
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: chosen }}
                    onPress={() => void setPreference(option.value)}
                    style={[styles.preferenceOption, chosen && styles.preferenceOptionChosen]}
                  >
                    <View style={styles.preferenceCopy}>
                      <Text style={styles.preferenceName}>{option.name}</Text>
                      <Text style={styles.preferenceDescription}>{option.description}</Text>
                    </View>
                    {chosen && <Check size={17} color={colors.primary} />}
                  </Pressable>
                )
              })}
              <Text style={styles.preferenceNote}>{zhCN.settings.transportNote}</Text>
            </View>

            <Text style={styles.groupLabel}>{zhCN.settings.identity}</Text>
            <View style={styles.group}>
              <KeyValue label={zhCN.settings.deviceId} value={shorten(identity?.deviceId)} mono />
              <KeyValue label={zhCN.settings.publicKey} value={fingerprint(identity?.publicKey)} mono />
              <View style={styles.keyNote}><KeyRound size={17} color={colors.muted} /><Text style={styles.keyNoteText}>{zhCN.settings.keyNote}</Text></View>
            </View>

            <View style={styles.resetArea}>
              <Button label={zhCN.settings.signOut} variant="secondary" onPress={confirmSignOut} />
              <View style={styles.resetGap} />
              <Button label={zhCN.settings.resetLocal} icon={RotateCcw} variant="danger" onPress={confirmReset} />
            </View>
          </View>
        </Screen>
      </BlurHeaderFrame>
    </View>
  )
}

export function HomeActionsMenu({ visible, onClose, onSettings, onDevices }: {
  visible: boolean
  onClose: () => void
  onSettings: () => void
  onDevices?: () => void
}) {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const { height: windowHeight, landscape, compactHeight } = useResponsiveLayout()

  if (!visible) return null

  // Landscape phones are short: keep the fixed-position menu below the bar but
  // inside the window, and let its rows scroll if they still cannot all fit.
  const shortWindow = landscape || compactHeight
  const menuTop = insets.top + (shortWindow ? 48 : 56)
  const menuMaxHeight = Math.max(120, windowHeight - menuTop - insets.bottom - spacing.xs)

  return (
    <View style={styles.homeMenuLayer} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={zhCN.common.close}
        onPress={onClose}
        pointerEvents="box-only"
        style={styles.homeMenuDismiss}
      />
      <View accessibilityRole="menu" style={[styles.homeMenuCard, { top: menuTop, maxHeight: menuMaxHeight }]} pointerEvents="box-none">
        <ScrollView style={styles.homeMenuScroll} bounces={false} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {onDevices !== undefined && (
            <HomeMenuRow icon={Laptop} label={zhCN.devices.myDevices} onPress={onDevices} />
          )}
          <HomeMenuRow icon={Settings} label={zhCN.settings.title} onPress={onSettings} last />
        </ScrollView>
      </View>
    </View>
  )
}

function HomeMenuRow({ icon: Icon, label, subtitle, onPress, disabled = false, last = false }: {
  icon: LucideIcon
  label: string
  subtitle?: string
  onPress: () => void
  disabled?: boolean
  last?: boolean
}) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.homeMenuRow,
        !last && styles.homeMenuRowBorder,
        pressed && !disabled && styles.homeMenuRowPressed,
        disabled && styles.homeMenuRowDisabled,
      ]}
    >
      <View style={styles.homeMenuRowIcon}><Icon size={19} color={colors.primary} /></View>
      <View style={styles.homeMenuRowCopy}>
        <Text style={styles.homeMenuRowLabel}>{label}</Text>
        {subtitle !== undefined && <Text style={styles.homeMenuRowSubtitle} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {disabled
        ? <ActivityIndicator size="small" color={colors.primary} />
        : <ChevronRight size={20} color={colors.subtle} />}
    </Pressable>
  )
}

function shorten(value?: string): string {
  if (value === undefined) return zhCN.common.unavailable
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value
}

function fingerprint(value?: string): string {
  if (value === undefined || value.length === 0) return zhCN.common.unavailable
  return value.slice(0, 24).toUpperCase().match(/.{1,4}/g)?.join(' ') ?? value
}

function languageOptions(): Array<{ value: LanguagePreference; name: string }> {
  return [
    { value: 'system', name: zhCN.settings.languageSystem },
    { value: 'zh-CN', name: zhCN.settings.languageChinese },
    { value: 'en-US', name: zhCN.settings.languageEnglish },
  ]
}

function themeOptions(): Array<{ value: ThemePreference; name: string }> {
  return [
    { value: 'light', name: zhCN.settings.themeLight },
    { value: 'dark', name: zhCN.settings.themeDark },
    { value: 'system', name: zhCN.settings.themeSystem },
  ]
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  // Reading cap for wide landscape tablets; the live width style is applied by
  // the screens that opt in (portrait phones never exceed the cap).
  contentColumn: { width: '100%', alignSelf: 'center' },
  productName: { ...type.smallStrong, color: colors.primary, marginTop: spacing.xxl, marginBottom: spacing.md },
  title: { ...type.hero, color: colors.ink, maxWidth: 340 },
  lead: { ...type.body, color: colors.muted, marginTop: spacing.sm, maxWidth: 520 },
  form: { marginTop: spacing.xxl, gap: spacing.md },
  methodTabs: { flexDirection: 'row', padding: 4, borderRadius: radius.md, backgroundColor: colors.surfaceStrong },
  methodTab: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  methodTabActive: { backgroundColor: colors.surface },
  methodTabText: { ...type.smallStrong, color: colors.muted },
  methodTabTextActive: { color: colors.primary },
  serverSection: { gap: spacing.sm, marginTop: spacing.sm, paddingTop: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  serverLabel: { ...type.smallStrong, color: colors.muted },
  oauthHint: { ...type.caption, color: colors.muted, textAlign: 'center' },
  securityNote: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surface, marginTop: spacing.xxxl },
  versionText: { ...type.caption, color: colors.muted, textAlign: 'center', marginTop: spacing.xl },
  securityCopy: { flex: 1 },
  securityTitle: { ...type.smallStrong, color: colors.ink },
  securityBody: { ...type.small, color: colors.muted, marginTop: 2 },
  settingsHeader: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', paddingVertical: spacing.xl },
  settingsIcon: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  settingsTitle: { ...type.heading, color: colors.ink },
  settingsSubtitle: { ...type.small, color: colors.muted },
  groupLabel: { ...type.smallStrong, color: colors.muted, marginTop: spacing.xl, marginBottom: spacing.xs },
  group: { borderRadius: radius.lg, backgroundColor: colors.surface, paddingHorizontal: spacing.md },
  preferenceList: { gap: spacing.xs },
  preferenceOption: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  preferenceOptionChosen: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  permissionOption: { minHeight: 48 },
  preferenceCopy: { flex: 1 },
  preferenceName: { ...type.smallStrong, color: colors.ink },
  languageName: { flex: 1 },
  preferenceDescription: { ...type.caption, color: colors.muted, marginTop: 2 },
  preferenceNote: { ...type.caption, color: colors.muted, marginTop: spacing.xs },
  segmentRow: { flexDirection: 'row', padding: 4, borderRadius: radius.md, backgroundColor: colors.surfaceStrong },
  segmentButton: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, paddingHorizontal: spacing.xs },
  segmentButtonActive: { backgroundColor: colors.surface },
  segmentButtonText: { ...type.smallStrong, color: colors.muted, textAlign: 'center' },
  segmentButtonTextActive: { color: colors.primary },
  keyNote: { flexDirection: 'row', gap: spacing.xs, paddingVertical: spacing.md },
  keyNoteText: { ...type.small, color: colors.muted, flex: 1 },
  settingsLink: { minHeight: 68, paddingVertical: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  settingsLinkPressed: { opacity: 0.68 },
  settingsLinkCopy: { flex: 1, gap: 3 },
  settingsLinkLabel: { ...type.smallStrong, color: colors.ink },
  settingsLinkUrl: { ...type.caption, color: colors.primary },
  homeMenuLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, elevation: 20 },
  homeMenuDismiss: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.menuDismiss },
  homeMenuCard: { position: 'absolute', right: spacing.sm, width: 236, paddingHorizontal: spacing.xs, borderRadius: radius.lg, backgroundColor: colors.surface, zIndex: 1, elevation: 8, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.14, shadowRadius: 14 },
  // flexGrow 0 keeps the card content-sized in portrait; flexShrink lets the
  // capped landscape card scroll instead of clipping its last row.
  homeMenuScroll: { flexGrow: 0, flexShrink: 1 },
  homeMenuRow: { minHeight: 56, paddingHorizontal: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  homeMenuRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  homeMenuRowPressed: { opacity: 0.68 },
  homeMenuRowDisabled: { opacity: 0.6 },
  homeMenuRowIcon: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  homeMenuRowCopy: { flex: 1 },
  homeMenuRowLabel: { ...type.smallStrong, color: colors.ink },
  homeMenuRowSubtitle: { ...type.caption, color: colors.muted, marginTop: 1 },
  aboutHero: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.xs },
  aboutLogo: { width: 84, height: 84, borderRadius: radius.lg, marginBottom: spacing.sm },
  aboutProductName: { ...type.title, color: colors.ink, textAlign: 'center' },
  aboutVersion: { ...type.small, color: colors.muted, textAlign: 'center' },
  resetArea: { marginTop: spacing.xxxl },
  resetGap: { height: spacing.sm },
  })
}
