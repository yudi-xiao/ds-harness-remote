import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { describe, expect, it } from 'vitest'
import { CHAT_ATTACHMENT_MAX_BYTES, sessionAttachmentDataUri } from '../src/services/session-attachment'

const reference = {
  attachmentId: 'sha256:abc',
  mediaType: 'image/jpeg',
  bytes: 3,
  width: 5,
  height: 6,
}

function value(data: string, attachment: Record<string, unknown> = reference): Record<string, unknown> {
  return { attachment, data }
}

describe('session attachment projection', () => {
  it('renders only the authorized reference with canonical bytes', async () => {
    await runScenarios([
      {
        name: 'builds a data URI for the expected attachment',
        run: () => {
          expect(sessionAttachmentDataUri(value('AAEC'), { attachmentId: 'sha256:abc', mediaType: 'image/jpeg' }))
            .toBe('data:image/jpeg;base64,AAEC')
        },
      },
      {
        name: 'rejects a different attachment id',
        run: () => {
          expect(sessionAttachmentDataUri(value('AAEC'), { attachmentId: 'sha256:other' })).toBeUndefined()
        },
      },
      {
        name: 'rejects a media type outside the image whitelist',
        run: () => {
          expect(sessionAttachmentDataUri(value('AAEC', { ...reference, mediaType: 'image/svg+xml' }), {
            attachmentId: 'sha256:abc',
          })).toBeUndefined()
        },
      },
      {
        name: 'rejects a media type different from the referenced block',
        run: () => {
          expect(sessionAttachmentDataUri(value('AAEC'), {
            attachmentId: 'sha256:abc',
            mediaType: 'image/png',
          })).toBeUndefined()
        },
      },
      {
        name: 'rejects non-canonical base64',
        run: () => {
          expect(sessionAttachmentDataUri(value('AAE'), { attachmentId: 'sha256:abc' })).toBeUndefined()
          expect(sessionAttachmentDataUri(value('AAE!'), { attachmentId: 'sha256:abc' })).toBeUndefined()
        },
      },
      {
        name: 'rejects a declared byte length that does not match the payload',
        run: () => {
          expect(sessionAttachmentDataUri(value('AAEC', { ...reference, bytes: 4 }), {
            attachmentId: 'sha256:abc',
          })).toBeUndefined()
        },
      },
      {
        name: 'rejects an attachment above the display budget',
        run: () => {
          expect(sessionAttachmentDataUri(value('AAEC', { ...reference, bytes: CHAT_ATTACHMENT_MAX_BYTES + 1 }), {
            attachmentId: 'sha256:abc',
          })).toBeUndefined()
        },
      },
    ])
  }, 15000)
})
