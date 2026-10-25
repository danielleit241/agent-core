import type { LLMPort } from '@agent-core/core'
import { expect, test } from 'vitest'
import { withoutLlmRetry } from './no-llm-retry'

const req = { model: 'default', messages: [], tools: [] }

test('a thrown error reaches the caller as not retryable, with the same message', async () => {
  const original = Object.assign(new Error('rate limited'), { retryable: true, retryAfterMs: 7000 })
  const llm = withoutLlmRetry({ complete: () => Promise.reject(original) })
  const err = (await llm.complete(req).catch((e: unknown) => e)) as Error & { retryable?: boolean; retryAfterMs?: number }
  expect(err.message).toBe('rate limited')
  expect(err.retryable).toBe(false)
  expect(err.retryAfterMs).toBeUndefined()
  expect(original.retryable).toBe(true) // the original is not mutated
})

test('a successful reply passes through', async () => {
  const reply = { message: { role: 'assistant' as const, content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' as const }
  const llm: LLMPort = withoutLlmRetry({ complete: () => Promise.resolve(reply) })
  expect(await llm.complete(req)).toBe(reply)
})
