import type { ContentStore } from '../ports'
import type { Label, NewEvent } from '../types'
import type { SecretMatcher } from './secrets'

export type Screened = { content: string; redactions: Record<string, number> }

export type ScreenOptions = {
  secrets: SecretMatcher
  /** The offload stage (M2.20) is not in place yet; the option is accepted and ignored. */
  offload?: { store: ContentStore; atChars: number }
}

/**
 * Every content on its way into the log or the LLM context goes through here. Stages, in order: label (the caller's),
 * remove secrets, mask PII (later), offload (later). The secrets go first, so the stored full text is clean too.
 */
export async function screenContent(text: string, opts: ScreenOptions): Promise<Screened> {
  const { text: content, redactions } = opts.secrets.redact(text)
  return { content, redactions }
}

/** The `tool.responded` event for a raw tool result: screened, with `redactions` only when something was removed. */
export async function screenedToolResponse(
  call: { toolCallId: string },
  raw: { content: string; isError: boolean },
  labels: Label[],
  opts: ScreenOptions,
): Promise<Extract<NewEvent, { type: 'tool.responded' }>> {
  const { content, redactions } = await screenContent(raw.content, opts)
  return {
    type: 'tool.responded',
    payload: {
      toolCallId: call.toolCallId,
      content,
      isError: raw.isError,
      ...(Object.keys(redactions).length === 0 ? {} : { redactions }),
    },
    labels,
  }
}
