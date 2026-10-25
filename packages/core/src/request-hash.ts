import { createHash } from 'node:crypto'
import { canonicalJson } from './hash'
import type { Message, ToolDescriptor } from './types'

const normaliseWs = (s: string): string => s.trim().replace(/\s+/g, ' ')

/**
 * Hash of what an LLM request means, not how it is spelled. Tool call ids, volatile items,
 * key order, whitespace runs and tool order or descriptions do not change it.
 */
export function requestHash(req: { model: string; messages: Message[]; tools: ToolDescriptor[] }): string {
  const messages = req.messages
    .filter((m) => m.volatile !== true)
    .map((m) => ({
      role: m.role,
      content: normaliseWs(m.content),
      toolCalls: m.toolCalls?.map((c) => ({ name: c.name, arguments: c.arguments, argumentsError: c.argumentsError })),
    }))
  const tools = req.tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return createHash('sha256').update(canonicalJson({ model: req.model, messages, tools })).digest('hex')
}
