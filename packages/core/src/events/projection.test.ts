import { NewEventSchema, type NewEvent, type StoredEvent } from '../types'
import { projectRun } from './projection'

const stored = (events: NewEvent[]): StoredEvent[] =>
  events.map((e, i) => ({
    ...e,
    tenantId: 't1',
    runId: 'r1',
    seq: i + 1,
    agentVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    prevHash: '',
    hash: '',
  }))

const created: NewEvent = {
  type: 'run.created',
  payload: { agentId: 'support', input: { text: 'hi' } },
  labels: ['untrusted'],
}
const running: NewEvent = { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] }
const requested: NewEvent = { type: 'llm.requested', payload: { model: 'm' }, labels: [] }
const responded: NewEvent = {
  type: 'llm.responded',
  payload: { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' },
  labels: [],
}
const retryError = (retryAt?: string): NewEvent => ({
  type: 'error.raised',
  payload: { message: 'LLM unavailable.', retryable: true, ...(retryAt === undefined ? {} : { retryAt }) },
  labels: [],
})

const waits: NewEvent[] = [
  created,
  running,
  requested,
  retryError('2026-01-01T00:00:30.000Z'),
  requested,
  retryError('2026-01-01T00:01:30.000Z'),
]

test('llmRetry counts retry waits since the last llm.responded', () => {
  expect(projectRun(stored(waits), '').llmRetry).toEqual({ attempts: 2, retryAt: '2026-01-01T00:01:30.000Z' })
})

test('a successful llm.responded resets llmRetry', () => {
  expect(projectRun(stored([...waits, requested, responded]), '').llmRetry).toEqual({ attempts: 0, retryAt: null })
})

test('error.raised without retryAt does not count', () => {
  const log = [created, running, requested, retryError()]
  expect(projectRun(stored(log), '').llmRetry).toEqual({ attempts: 0, retryAt: null })
})

test('an old error.raised without retryAt still parses', () => {
  expect(() => NewEventSchema.parse(retryError())).not.toThrow()
})
