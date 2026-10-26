import type { ContentStore } from '../ports'
import type { Label, NewEvent } from '../types'
import { capStored, countLines, handleOf, offloadPreview, type Offload } from './offload'
import type { SecretMatcher } from './secrets'
import { contentHash } from './snapshot'

const NUL_OR_LONE_SURROGATE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

export type Screened = { content: string; redactions: Record<string, number>; offload?: Offload }

export type ScreenOptions = {
  secrets: SecretMatcher
  /** Content longer than `atChars` is stored whole in `store`; the content that comes back is its preview. */
  offload?: { store: ContentStore; atChars: number }
}

/**
 * Every content on its way into the log or the LLM context goes through here. Stages, in order: label (the caller's),
 * remove secrets, mask PII (later), offload. The secrets go first, so the stored full text is clean too.
 */
export async function screenContent(text: string, opts: ScreenOptions): Promise<Screened> {
  const redacted = opts.secrets.redact(text)
  // Postgres refuses U+0000 and lone surrogates (in jsonb and in a stored blob): the same rule as the run store.
  const content = redacted.text.replace(NUL_OR_LONE_SURROGATE, '�')
  const { redactions } = redacted
  if (opts.offload === undefined || content.length <= opts.offload.atChars) return { content, redactions }
  const stored = capStored(content)
  const hash = contentHash(stored)
  await opts.offload.store.put([stored])
  const offload: Offload = { handle: handleOf(hash), hash, chars: stored.length, lines: countLines(stored) }
  return { content: offloadPreview(stored, offload), redactions, offload }
}

/** The `tool.responded` event for a raw tool result: screened, with `redactions` only when something was removed. */
export async function screenedToolResponse(
  call: { toolCallId: string },
  raw: { content: string; isError: boolean },
  labels: Label[],
  opts: ScreenOptions,
): Promise<Extract<NewEvent, { type: 'tool.responded' }>> {
  const { content, redactions, offload } = await screenContent(raw.content, opts)
  return {
    type: 'tool.responded',
    payload: {
      toolCallId: call.toolCallId,
      content,
      isError: raw.isError,
      ...(Object.keys(redactions).length === 0 ? {} : { redactions }),
      ...(offload === undefined ? {} : { offload }),
    },
    labels,
  }
}
