import { createHash } from 'node:crypto'
import { canonicalJson } from '../events/hash'
import type { ContentStore } from '../ports'
import type { Message, ToolDescriptor } from '../types'

/** SHA-256 (hex) of a text: the key of a stored part. */
export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** What was sent for one message. The volatile flag is dropped; the volatile item itself is kept. */
export const messagePart = (m: Message): string =>
  canonicalJson({ role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.toolCallId })

export const toolPart = (t: ToolDescriptor): string => canonicalJson({ name: t.name, description: t.description, inputSchema: t.inputSchema })

/** What a manifest holds: a message is a part hash, or the part text itself when it is volatile (the time). */
export type Manifest = { messages: (string | { inline: string })[]; tools: string[]; output?: { name: string; schema: unknown } }

/** Characters of a message as sent: its content and its tool calls. */
export const messageChars = (m: Message): number => m.content.length + (m.toolCalls === undefined ? 0 : canonicalJson(m.toolCalls).length)

/**
 * Stores every message and tool descriptor of an LLM request once, by hash, and one manifest that lists them in
 * request order. Returns the manifest hash, so the event stays the same size however long the run is.
 * `chars` is the size of what was sent: message contents, tool calls and tool JSON.
 */
export async function snapshotRequest(
  store: ContentStore,
  req: { messages: Message[]; tools: ToolDescriptor[]; output?: { name: string; schema: unknown } },
): Promise<{ snapshot: string; chars: number }> {
  const parts = req.messages.filter((m) => m.volatile !== true).map(messagePart)
  const toolParts = req.tools.map(toolPart)
  const manifest: Manifest = {
    messages: req.messages.map((m) => (m.volatile === true ? { inline: messagePart(m) } : contentHash(messagePart(m)))),
    tools: toolParts.map(contentHash),
    ...(req.output === undefined ? {} : { output: req.output }),
  }
  const manifestText = canonicalJson(manifest)
  await store.put([...parts, ...toolParts, manifestText])
  const chars = req.messages.reduce((n, m) => n + messageChars(m), 0) + toolParts.reduce((n, t) => n + t.length, 0)
  return { snapshot: contentHash(manifestText), chars }
}
