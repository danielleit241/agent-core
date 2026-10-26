import { NewEventSchema, type LimitName, type NewEvent, type RunStatus, type StoredEvent } from '../../src/types'
import { projectRun } from '../../src/events/projection'

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

const usage = (inputTokens: number, outputTokens: number, costUsd?: number): NewEvent => ({
  type: 'llm.responded',
  payload: {
    message: { role: 'assistant', content: '', toolCalls: [] },
    usage: { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) },
    stopReason: 'tool_calls',
  },
  labels: [],
})
const toState = (from: RunStatus, to: RunStatus, extra: { reason?: string; expiresAt?: string } = {}): NewEvent => ({
  type: 'run.state_changed',
  payload: { from, to, ...extra },
  labels: [],
})
const continued = (limit: LimitName): NewEvent => ({ type: 'limit.continued', payload: { limit }, labels: ['trusted'] })
/** Stores events with the given ISO times, one per event. */
const timed = (events: [NewEvent, string][]): StoredEvent[] =>
  stored(events.map(([e]) => e)).map((e, i) => ({ ...e, createdAt: events[i]![1] }))

test('tokens and cost add up over llm.responded; a usage without cost adds 0', () => {
  const proj = projectRun(stored([created, running, usage(100, 20, 0.5), usage(10, 5), usage(1, 1, 0.25)]), '')
  expect(proj.tokens).toBe(137)
  expect(proj.costUsd).toBe(0.75)
})

test('limit.continued counts grants per limit', () => {
  const proj = projectRun(stored([created, running, continued('tokens'), continued('tokens')]), '')
  expect(proj.limitGrants.tokens).toBe(2)
  expect(proj.limitGrants.llm_calls).toBe(0)
})

test('a legacy breaker wait continued counts as an llm_calls grant', () => {
  const log = [created, running, toState('running', 'waiting_human', { reason: 'breaker' }), continued('llm_calls')]
  expect(projectRun(stored(log), '').limitGrants.llm_calls).toBe(1)
})

test('running time sums closed intervals and keeps the open one', () => {
  const proj = projectRun(
    timed([
      [created, '2026-01-01T00:00:00.000Z'],
      [running, '2026-01-01T00:00:00.000Z'],
      [toState('running', 'waiting_human', { reason: 'approval' }), '2026-01-01T00:00:10.000Z'],
      [toState('waiting_human', 'running'), '2026-01-01T00:01:10.000Z'],
    ]),
    '',
  )
  expect(proj.runningMs).toBe(10_000)
  expect(proj.runningSince).toBe('2026-01-01T00:01:10.000Z')
})

test('a wait records when it started and when it expires', () => {
  const wait = toState('running', 'waiting_human', { reason: 'approval', expiresAt: '2026-01-02T00:00:00.000Z' })
  const log: [NewEvent, string][] = [
    [created, '2026-01-01T00:00:00.000Z'],
    [running, '2026-01-01T00:00:00.000Z'],
    [wait, '2026-01-01T00:00:10.000Z'],
  ]
  const waiting = projectRun(timed(log), '')
  expect(waiting.waitStartedAt).toBe('2026-01-01T00:00:10.000Z')
  expect(waiting.waitExpiresAt).toBe('2026-01-02T00:00:00.000Z')
  expect(waiting.runningSince).toBeNull()
  const resumed = projectRun(timed([...log, [toState('waiting_human', 'running'), '2026-01-01T00:00:20.000Z']]), '')
  expect(resumed.waitStartedAt).toBeNull()
  expect(resumed.waitExpiresAt).toBeNull()
})

test('a wait without expiresAt never expires', () => {
  const proj = projectRun(stored([created, running, toState('running', 'waiting_human', { reason: 'approval' })]), '')
  expect(proj.waitExpiresAt).toBeNull()
})

describe('run input', () => {
  const message = (text: string): NewEvent => ({ type: 'input.received', payload: { action: 'message', text }, labels: ['untrusted'] })
  const cancel: NewEvent = { type: 'input.received', payload: { action: 'cancel' }, labels: [] }
  const callTurn: NewEvent = {
    type: 'llm.responded',
    payload: {
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }, { id: 'c2', name: 't', arguments: {} }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'tool_calls',
    },
    labels: [],
  }
  const result = (id: string): NewEvent => ({ type: 'tool.responded', payload: { toolCallId: id, content: 'r', isError: false }, labels: [] })

  test('input.received accepts cancel and a bounded message, and refuses a message without text', () => {
    expect(NewEventSchema.safeParse(message('steer')).success).toBe(true)
    expect(NewEventSchema.safeParse(cancel).success).toBe(true)
    expect(NewEventSchema.safeParse({ ...cancel, payload: { action: 'message' } }).success).toBe(false)
    // The stored text may be longer than the 32,000-character request limit (a redaction marker is longer than a short secret).
    expect(NewEventSchema.safeParse(message('x'.repeat(32_001))).success).toBe(true)
    expect(NewEventSchema.safeParse(message('x'.repeat(200_001))).success).toBe(false)
  })

  test('a message becomes a user message where it arrives when no tool call is open', () => {
    const p = projectRun(stored([created, running, requested, responded, message('steer')]), 'sys')
    expect(p.messages.at(-1)).toEqual({ role: 'user', content: 'steer' })
  })

  test('a message that arrives while tool calls are open waits until the last result', () => {
    const p = projectRun(stored([created, running, requested, callTurn, result('c1'), message('steer'), result('c2')]), 'sys')
    expect(p.messages.slice(-3).map((m) => m.role)).toEqual(['tool', 'tool', 'user'])
    const open = projectRun(stored([created, running, requested, callTurn, message('steer'), result('c1')]), 'sys')
    expect(open.messages.some((m) => m.role === 'user' && m.content === 'steer')).toBe(false)
  })

  test('a message that arrives during an LLM call goes after its answer, or after an LLM error', () => {
    const answered = projectRun(stored([created, running, requested, message('steer'), responded]), 'sys')
    expect(answered.messages.slice(-2).map((m) => m.role)).toEqual(['assistant', 'user'])
    const failed = projectRun(stored([created, running, requested, message('steer'), retryError('2026-01-01T00:00:30.000Z')]), 'sys')
    expect(failed.messages.at(-1)).toEqual({ role: 'user', content: 'steer' })
  })

  test('unreadMessages counts messages after the last LLM request', () => {
    expect(projectRun(stored([created, running, message('a'), requested]), 'sys').unreadMessages).toBe(0)
    expect(projectRun(stored([created, running, requested, message('a'), message('b')]), 'sys').unreadMessages).toBe(2)
  })

  test('cancelRequested is set by a cancel input and lastSeq is the seq of the last event', () => {
    const p = projectRun(stored([created, running, cancel]), 'sys')
    expect(p.cancelRequested).toBe(true)
    expect(p.lastSeq).toBe(3)
    expect(projectRun(stored([created, running]), 'sys').cancelRequested).toBe(false)
  })
})
