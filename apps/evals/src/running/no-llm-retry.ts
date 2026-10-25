import type { LLMPort } from '@agent-core/core'

/**
 * Evals stop only queued or waiting_human runs, so a run waiting 30 s or more for an LLM retry would
 * stall them. A thrown error reaches the runner as not retryable, with the same message.
 */
export function withoutLlmRetry(llm: LLMPort): LLMPort {
  return {
    async complete(req) {
      try {
        return await llm.complete(req)
      } catch (err) {
        throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { retryable: false })
      }
    },
  }
}
