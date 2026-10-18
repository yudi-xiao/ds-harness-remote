import type { ImageMediaType, SessionAttachmentValue } from '../types'

/** Deployment-normalized images are small; larger values are refused instead of buffered. */
export const CHAT_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024
/** JSON (base64 + metadata + envelope) allowance for one attachment lookup response. */
export const CHAT_ATTACHMENT_MAX_RESPONSE_BYTES = Math.ceil((CHAT_ATTACHMENT_MAX_BYTES * 4) / 3) + 2 * 1024 * 1024

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/**
 * Validate one official `session/attachment` lookup and turn it into a display
 * data URI. The Host proves the image is referenced by the addressed session;
 * the Client still refuses a mismatched id/media type or malformed base64 so a
 * stale or cross-session response can never render as this chat image.
 */
export function sessionAttachmentDataUri(
  value: unknown,
  expected: { attachmentId: string; mediaType?: ImageMediaType },
): string | undefined {
  if (!isRecord(value) || !isRecord(value.attachment)) return undefined
  const attachment = value.attachment
  if (attachment.attachmentId !== expected.attachmentId) return undefined
  const mediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined
  const data = typeof value.data === 'string' ? value.data : undefined
  const bytes = typeof attachment.bytes === 'number' && Number.isSafeInteger(attachment.bytes) ? attachment.bytes : undefined
  if (mediaType === undefined || !IMAGE_MEDIA_TYPES.has(mediaType)) return undefined
  if (expected.mediaType !== undefined && mediaType !== expected.mediaType) return undefined
  if (data === undefined || bytes === undefined || bytes <= 0 || bytes > CHAT_ATTACHMENT_MAX_BYTES) return undefined
  if (data.length === 0 || data.length % 4 !== 0 || !CANONICAL_BASE64.test(data)) return undefined
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  if ((data.length / 4) * 3 - padding !== bytes) return undefined
  return `data:${mediaType};base64,${data}`
}

/** Narrow the typed Host response before the validator sees it. */
export function isSessionAttachmentValue(value: unknown): value is SessionAttachmentValue {
  return isRecord(value) && isRecord(value.attachment) && typeof value.data === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
