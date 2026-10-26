import type { StoredEvent } from '@agent-core/core'

export type Metrics = {
  inputTokens: number
  outputTokens: number
  /** The largest `usage.inputTokens` of one call: the size of the biggest context. */
  peakInputTokens: number
  llmTurns: number
  toolCalls: number
  /** Present only when every response has a cost. */
  costUsd?: number
}

/** Figures of the agent's own run. The rubric judge does not write events, so it is not counted. */
export function metricsOf(events: StoredEvent[]): Metrics {
  let inputTokens = 0
  let outputTokens = 0
  let peakInputTokens = 0
  let llmTurns = 0
  let toolCalls = 0
  let costUsd: number | undefined = 0
  for (const e of events) {
    if (e.type === 'tool.requested') toolCalls++
    if (e.type !== 'llm.responded') continue
    const { usage } = e.payload
    llmTurns++
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    peakInputTokens = Math.max(peakInputTokens, usage.inputTokens)
    costUsd = costUsd === undefined || usage.costUsd === undefined ? undefined : costUsd + usage.costUsd
  }
  const metrics: Metrics = { inputTokens, outputTokens, peakInputTokens, llmTurns, toolCalls }
  return llmTurns > 0 && costUsd !== undefined ? { ...metrics, costUsd } : metrics
}
