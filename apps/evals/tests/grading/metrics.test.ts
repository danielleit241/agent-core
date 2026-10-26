import { expect, test } from 'vitest'
import type { StoredEvent } from '@agent-core/core'
import { metricsOf } from '../../src/grading/metrics'

const base = { labels: [], tenantId: 't', runId: 'r', seq: 1, agentVersion: 1, createdAt: '', prevHash: '', hash: '' }

const llm = (inputTokens: number, outputTokens: number, costUsd?: number): StoredEvent =>
  ({
    ...base,
    type: 'llm.responded',
    payload: {
      message: { role: 'assistant', content: 'x' },
      usage: { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) },
      stopReason: 'end',
    },
  }) as StoredEvent

const tool = (name: string): StoredEvent =>
  ({ ...base, type: 'tool.requested', payload: { toolCallId: 'c', tool: name, args: {}, idempotencyKey: 'k' } }) as StoredEvent

test('sums tokens, takes the largest input as the peak and counts turns and tool calls', () => {
  const events = [llm(100, 10, 0.1), tool('a'), llm(300, 20, 0.2), tool('b'), llm(200, 30)]
  // One response has no cost, so there is no total cost.
  expect(metricsOf(events)).toEqual({ inputTokens: 600, outputTokens: 60, peakInputTokens: 300, llmTurns: 3, toolCalls: 2 })
})

test('adds the cost when every response has one', () => {
  expect(metricsOf([llm(1, 1, 0.1), llm(1, 1, 0.2)]).costUsd).toBeCloseTo(0.3)
})

test('a run without events has zero metrics and no cost', () => {
  expect(metricsOf([])).toEqual({ inputTokens: 0, outputTokens: 0, peakInputTokens: 0, llmTurns: 0, toolCalls: 0 })
})
