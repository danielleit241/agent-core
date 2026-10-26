import type { Message, ToolCall } from '../types'

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** JSON of the arguments with sorted keys, so key order never makes two calls differ. */
export const canonicalArgs = (args: Record<string, unknown>): string => JSON.stringify(sortKeys(args))

const callKey = (c: ToolCall): string => `${c.name}\n${canonicalArgs(c.arguments)}`

/** How many calls the model made before `call` with the same tool and arguments, whatever their outcome. */
export function repeatedCalls(messages: Message[], call: ToolCall): number {
  const key = callKey(call)
  let count = 0
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      if (c.id === call.id) return count
      if (callKey(c) === key) count++
    }
  }
  return count
}

/**
 * How many of the last tool turns added no new tool result: every call in the turn has the same tool,
 * arguments and result as an earlier call.
 */
export function stalledTurns(messages: Message[]): number {
  const results = new Map<string, string>()
  for (const m of messages) if (m.role === 'tool' && m.toolCallId !== undefined) results.set(m.toolCallId, m.content)
  const seen = new Set<string>()
  let stalled = 0
  for (const m of messages) {
    const calls = m.toolCalls ?? []
    if (calls.length === 0) continue
    const keys = calls.map((c) => `${callKey(c)}\n${results.get(c.id) ?? ''}`)
    const isNew = keys.some((k) => !seen.has(k))
    for (const k of keys) seen.add(k)
    stalled = isNew ? 0 : stalled + 1
  }
  return stalled
}
