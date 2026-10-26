import { handleOf, stubSize } from '../content/offload'
import type { RunProjection } from '../events/projection'
import type { ContentStore } from '../ports'
import type { NewEvent } from '../types'
import { ASK_HUMAN_TOOL, ESCALATE_TOOL } from './builtins'

/** Results this short are not worth a stub. */
const MIN_CLEAR_CHARS = 300
/** Compact rarely and in large parts, so the provider's prompt cache survives between compactions (ADR 0012). */
const TARGET_RATIO = 0.5

/** Human answers: the person said it, no handle will bring it back as they said it. */
const NEVER_CLEARED = new Set([ASK_HUMAN_TOOL, ESCALATE_TOOL])

export type CompactionPlan = {
  estimatedBefore: number
  estimatedAfter: number
  clear: { toolCallId: string; content: string }[]
}

/**
 * Plans which tool outputs to clear before the next LLM request, or null when nothing is needed or nothing can be cleared.
 * The next request is estimated from the last measured one: its input tokens plus the tokens per character of that call
 * times the characters added since. At the threshold, the oldest outputs go first until the estimate is at most half of it.
 * Never cleared: other roles, the results of the latest assistant turn, `ask_human` and `escalate` results, outputs of
 * 300 characters or less, existing stubs. `readOutputChars` is the size of the `read_output` descriptor, which joins the
 * tools of the request once the run holds a handle and the measured call had none.
 */
export function planCompaction(proj: RunProjection, thresholdTokens: number, readOutputChars = 0): CompactionPlan | null {
  const size = proj.contextSize
  if (size === null) return null
  const toolDelta = size.hadHandles ? 0 : size.tokensPerChar * readOutputChars
  const estimatedBefore = size.tokens + size.tokensPerChar * size.addedChars + (proj.handles.size > 0 ? toolDelta : 0)
  if (estimatedBefore < thresholdTokens) return null

  const toolNames = new Map(proj.messages.flatMap((m) => m.toolCalls?.map((c) => [c.id, c.name] as const) ?? []))
  const latestTurn = new Set(proj.messages.findLast((m) => m.role === 'assistant')?.toolCalls?.map((c) => c.id))
  let estimate = estimatedBefore
  const clear: CompactionPlan['clear'] = []
  for (const m of proj.messages) {
    if (estimate <= thresholdTokens * TARGET_RATIO) break
    if (m.role !== 'tool' || m.toolCallId === undefined || latestTurn.has(m.toolCallId) || NEVER_CLEARED.has(toolNames.get(m.toolCallId) ?? '')) continue
    const out = proj.toolOutputs.get(m.toolCallId)
    if (out === undefined || out.stubbed || m.content.length <= MIN_CLEAR_CHARS) continue
    clear.push({ toolCallId: m.toolCallId, content: m.content })
    estimate -= size.tokensPerChar * (m.content.length - stubSize(out.offload?.chars ?? m.content.length))
  }
  // Clearing makes a handle, so the next request carries the descriptor.
  if (clear.length > 0 && proj.handles.size === 0) estimate += toolDelta
  return clear.length === 0 ? null : { estimatedBefore: Math.round(estimatedBefore), estimatedAfter: Math.round(estimate), clear }
}

/**
 * The `context.compacted` event for the next request, or null. An output that was offloaded keeps its handle; any other
 * is stored whole in the content store first and gets a handle the same way.
 */
export async function compactionEvent(content: ContentStore, proj: RunProjection, thresholdTokens: number, readOutputChars = 0): Promise<NewEvent | null> {
  const plan = planCompaction(proj, thresholdTokens, readOutputChars)
  if (plan === null) return null
  const inline = plan.clear.filter((c) => proj.toolOutputs.get(c.toolCallId)?.offload === undefined)
  const hashes = await content.put(inline.map((c) => c.content))
  const hashOf = new Map(inline.map((c, i) => [c.toolCallId, hashes[i]!]))
  const cleared = plan.clear.map((c) => {
    const offload = proj.toolOutputs.get(c.toolCallId)?.offload
    if (offload !== undefined) return { toolCallId: c.toolCallId, handle: offload.handle, hash: offload.hash, chars: offload.chars }
    const hash = hashOf.get(c.toolCallId)!
    return { toolCallId: c.toolCallId, handle: handleOf(hash), hash, chars: c.content.length }
  })
  return {
    type: 'context.compacted',
    payload: { estimatedBefore: plan.estimatedBefore, estimatedAfter: plan.estimatedAfter, threshold: thresholdTokens, cleared },
    labels: [],
  }
}
