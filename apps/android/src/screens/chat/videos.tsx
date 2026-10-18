import { Film, Play, X } from 'lucide-react-native'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { strings as zhCN } from '../../locales/i18n'
import {
  cachedChatVideo,
  CHAT_VIDEO_INVALID,
  CHAT_VIDEO_TOO_LARGE,
  downloadChatVideo,
} from '../../services/chat-video'
import { requireSessionTools } from '../../state/store'
import type { ChatImage, ChatVideo } from '../../types'
import { useTheme } from '../../ui/theme-context'
import { spacing, type } from '../../ui/theme'

/**
 * A video result stored in the session workspace. Only the MP4 poster and
 * metadata are rendered up front; the bytes are streamed from the Host through
 * the official read-only workspace file API when the user taps play.
 */
export function ChatVideoCard({ sessionId, video, poster }: {
  sessionId: string
  video: ChatVideo
  poster?: ChatImage
}) {
  const { colors } = useTheme()
  const [uri, setUri] = useState<string | undefined>(() => cachedChatVideo(sessionId, video)?.uri)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ loaded: number; total?: number } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [playerOpen, setPlayerOpen] = useState(false)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
    abortRef.current?.abort()
  }, [])
  const aspectRatio = video.width !== undefined && video.height !== undefined && video.width > 0 && video.height > 0
    ? Math.min(2.4, Math.max(0.5, video.width / video.height))
    : 16 / 9
  const posterUri = poster?.uri
  const duration = video.durationSeconds === undefined ? undefined : formatDuration(video.durationSeconds)

  const open = async () => {
    if (uri !== undefined) {
      setPlayerOpen(true)
      return
    }
    if (loading) return
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(undefined)
    setProgress(undefined)
    try {
      const tools = requireSessionTools(sessionId)
      const result = await downloadChatVideo(tools, sessionId, video, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (mounted.current) setProgress(total === undefined ? { loaded } : { loaded, total })
        },
      })
      if (!mounted.current) return
      setUri(result.uri)
      setPlayerOpen(true)
    } catch (cause) {
      if (!mounted.current) return
      setError(videoErrorText(cause))
    } finally {
      abortRef.current = undefined
      if (mounted.current) {
        setLoading(false)
        setProgress(undefined)
      }
    }
  }

  const percent = progress?.total !== undefined && progress.total > 0
    ? Math.min(99, Math.floor((progress.loaded / progress.total) * 100))
    : undefined

  return (
    <View style={[styles.card, { borderColor: colors.separator }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={zhCN.chat.videoPlay}
        accessibilityState={{ busy: loading }}
        onPress={() => void open()}
        style={({ pressed }) => [styles.posterFrame, { backgroundColor: colors.surface, aspectRatio }, pressed && styles.pressed]}
      >
        {posterUri !== undefined
          ? <Image source={{ uri: posterUri }} style={styles.poster} resizeMode="cover" />
          : <View style={[styles.poster, styles.placeholder]}><Film size={36} color={colors.muted} /></View>}
        <View style={styles.scrim} />
        <View style={[styles.playButton, { backgroundColor: colors.primary }]}>
          {loading
            ? <ActivityIndicator size="small" color={colors.white} />
            : <Play size={26} color={colors.white} fill={colors.white} />}
        </View>
        {duration !== undefined && <View style={styles.durationBadge}><Text style={styles.durationText}>{duration}</Text></View>}
        {loading && (
          <View style={styles.progressOverlay}>
            <Text style={styles.progressText}>
              {percent === undefined ? zhCN.chat.videoPreparing : zhCN.chat.videoDownloadProgress(percent)}
            </Text>
          </View>
        )}
      </Pressable>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{video.title ?? zhCN.chat.videoResult}</Text>
        <Text style={[styles.meta, { color: error === undefined ? colors.muted : colors.danger }]} numberOfLines={2}>
          {error ?? zhCN.chat.videoResult}
        </Text>
      </View>
      {playerOpen && uri !== undefined && (
        <VideoPlayerModal uri={uri} title={video.title ?? zhCN.chat.videoResult} onClose={() => setPlayerOpen(false)} />
      )}
    </View>
  )
}

function VideoPlayerModal({ uri, title, onClose }: { uri: string; title: string; onClose: () => void }) {
  const player = useVideoPlayer(uri, instance => { instance.play() })
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.playerBackdrop}>
        <View style={styles.playerHeader}>
          <Text style={styles.playerTitle} numberOfLines={1}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={zhCN.chat.videoPlayerClose} onPress={onClose} style={styles.playerClose}>
            <X size={20} color="#FFFFFF" />
          </Pressable>
        </View>
        <VideoView
          player={player}
          style={styles.playerVideo}
          contentFit="contain"
          nativeControls
          fullscreenOptions={{ enable: true }}
        />
      </View>
    </Modal>
  )
}

function videoErrorText(cause: unknown): string {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code?: unknown }).code : undefined
  if (code === CHAT_VIDEO_TOO_LARGE) return zhCN.chat.videoTooLarge
  if (code === CHAT_VIDEO_INVALID) return zhCN.chat.videoUnavailable
  return zhCN.chat.videoDownloadFailed
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`
}

const absoluteFill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 }

const styles = StyleSheet.create({
  card: { marginTop: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  posterFrame: { width: '100%', overflow: 'hidden' },
  poster: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.9 },
  scrim: { ...absoluteFill, backgroundColor: 'rgba(0,0,0,0.18)' },
  playButton: { position: 'absolute', alignSelf: 'center', top: '50%', marginTop: -28, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  durationBadge: { position: 'absolute', right: spacing.sm, bottom: spacing.sm, backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  durationText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  progressOverlay: { ...absoluteFill, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center' },
  progressText: { color: '#FFFFFF', ...type.smallStrong },
  copy: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { ...type.smallStrong },
  meta: { ...type.small, marginTop: 2 },
  playerBackdrop: { flex: 1, backgroundColor: '#000000', justifyContent: 'center' },
  playerHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 48, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, backgroundColor: 'rgba(0,0,0,0.55)' },
  playerTitle: { color: '#FFFFFF', ...type.smallStrong, flex: 1, marginRight: spacing.md },
  playerClose: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' },
  playerVideo: { width: '100%', height: '88%' },
})
