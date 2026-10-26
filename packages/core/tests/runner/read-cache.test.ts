import { projectRun } from '../../src/events/projection'
import { findCachedRead } from '../../src/runner/read-cache'
import type { NewEvent, StoredEvent, ToolCall, ToolDescriptor } from '../../src/types'

const read = (name: string, connectionId: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  description: '',
  inputSchema: {},
  safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'internal' },
  connectionId,
  ...extra,
})
const write = (name: string, connectionId: string): ToolDescriptor => ({
  ...read(name, connectionId),
  safety: { effect: 'write', idempotency: false, reachesOutside: true, outputLabel: 'internal' },
})

const GET = read('orders.get', 'shop')
const TOOLS: Record<string, ToolDescriptor> = {
  'orders.get': GET,
  'payments.refund': write('payments.refund', 'shop'),
  'tickets.create': write('tickets.create', 'desk'),
  'agent_core.schedule_followup': { ...write('agent_core.schedule_followup', 'agent_core') },
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

/** A log with a first read at second 0 and the given events after it; `times` gives the second of each. */
function log(...later: [NewEvent, number?][]): StoredEvent[] {
  const first: [NewEvent, number][] = [
    [{ type: 'run.created', payload: { agentId: 'a', input: { text: 'hi' } }, labels: ['untrusted'] }, 0],
    [
      { type: 'tool.requested', payload: { toolCallId: 'c1', tool: 'orders.get', args: { b: 2, a: 1 }, idempotencyKey: 'k1' }, labels: [] },
      0,
    ],
    [{ type: 'tool.responded', payload: { toolCallId: 'c1', content: 'order 1', isError: false }, labels: ['internal'] }, 0],
  ]
  const all = [...first, ...later.map(([e, s]) => [e, s ?? 0] as [NewEvent, number])]
  return all.map(([e, s], i) => ({ ...e, tenantId: 't', runId: 'r', seq: i + 1, agentVersion: 1, createdAt: at(s), prevHash: '', hash: '' }) as StoredEvent)
}
/** Like `log`, but the whole log is given. */
const rawLog = (...all: [NewEvent, number][]): StoredEvent[] =>
  all.map(([e, s], i) => ({ ...e, tenantId: 't', runId: 'r', seq: i + 1, agentVersion: 1, createdAt: at(s), prevHash: '', hash: '' }) as StoredEvent)
const sent = (id: string, tool: string): NewEvent => ({
  type: 'tool.requested',
  payload: { toolCallId: id, tool, args: {}, idempotencyKey: id },
  labels: [],
})
const answered = (id: string, isError = false): NewEvent => ({ type: 'tool.responded', payload: { toolCallId: id, content: 'x', isError }, labels: [] })

const call: ToolCall = { id: 'c9', name: 'orders.get', arguments: { a: 1, b: 2 } }
const find = (events: StoredEvent[], nowS = 1, tool: ToolDescriptor = GET, tools = TOOLS, c = call) =>
  findCachedRead(projectRun(events, ''), c, tool, tools, new Date(T0 + nowS * 1000))

test('a repeated read is a hit, whatever the key order; it carries the original payload and labels', () => {
  expect(find(log(), 5)).toEqual({
    fromToolCallId: 'c1',
    ageS: 5,
    payload: { toolCallId: 'c1', content: 'order 1', isError: false },
    labels: ['internal'],
  })
})

test('other arguments or another tool miss', () => {
  expect(find(log(), 1, GET, TOOLS, { ...call, arguments: { a: 1, b: 3 } })).toBeNull()
  const other = read('orders.list', 'shop')
  expect(find(log(), 1, other, { ...TOOLS, 'orders.list': other }, { ...call, name: 'orders.list' })).toBeNull()
})

test('a write to the same connection clears; a write to another connection does not', () => {
  expect(find(log([sent('c2', 'payments.refund')], [answered('c2')]))).toBeNull()
  expect(find(log([sent('c2', 'tickets.create')], [answered('c2')]))).not.toBeNull()
})

test('an unknown tool that was sent clears every connection', () => {
  expect(find(log([sent('c2', 'gone.tool')], [answered('c2')]))).toBeNull()
})

test('built-ins never clear, not even schedule_followup', () => {
  expect(find(log([sent('c2', 'agent_core.schedule_followup')], [answered('c2')]))).not.toBeNull()
})

test('a write that was never sent (rejected, denied) does not clear', () => {
  const rejected: NewEvent = { type: 'tool.responded', payload: { toolCallId: 'c2', content: 'rejected', isError: true }, labels: [] }
  expect(find(log([rejected]))).not.toBeNull()
})

test('TTL: age 59 s hits, 61 s misses; a tool TTL overrides the default; 0 is off', () => {
  expect(find(log(), 59)).not.toBeNull()
  expect(find(log(), 61)).toBeNull()
  const long = read('orders.get', 'shop', { cacheTtlS: 300 })
  expect(find(log(), 200, long, { ...TOOLS, 'orders.get': long })).not.toBeNull()
  const off = read('orders.get', 'shop', { cacheTtlS: 0 })
  expect(find(log(), 1, off, { ...TOOLS, 'orders.get': off })).toBeNull()
})

test('age counts from the answer, not from the request', () => {
  const events = log()
  events[2] = { ...events[2]!, createdAt: at(30) }
  expect(find(events, 61)).not.toBeNull()
})

test('a tool changed since review never hits; neither does a write', () => {
  const changed = read('orders.get', 'shop', { changedSinceReview: true })
  expect(find(log(), 1, changed)).toBeNull()
  expect(find(log(), 1, TOOLS['payments.refund']!, TOOLS, { ...call, name: 'payments.refund' })).toBeNull()
})

test('an error result is never served; an earlier good one still is', () => {
  const failing = log([sent('c2', 'orders.get')], [answered('c2', true)])
  expect(find(failing)).toMatchObject({ fromToolCallId: 'c1' })
  const onlyError = log().map((e) => (e.type === 'tool.responded' ? ({ ...e, payload: { ...e.payload, isError: true } } as StoredEvent) : e))
  expect(find(onlyError)).toBeNull()
})

test('a call served from the cache is not a source: the hit points at the original', () => {
  const hit: NewEvent = { type: 'tool.responded', payload: { toolCallId: 'c2', content: 'order 1', isError: false }, labels: ['internal'] }
  expect(find(log([hit, 10]))).toMatchObject({ fromToolCallId: 'c1' })
})

test('a changed output label is a miss: the old answer carries the old label', () => {
  const relabelled = read('orders.get', 'shop', { safety: { ...GET.safety, outputLabel: 'confidential' } })
  expect(find(log(), 1, relabelled, { ...TOOLS, 'orders.get': relabelled })).toBeNull()
})

test('a workflow subrun step clears the whole cache', () => {
  const started: NewEvent = { type: 'step.started', payload: { stepId: 's', kind: 'subrun' }, labels: [] }
  expect(find(log([started]))).toBeNull()
  const llmStep: NewEvent = { type: 'step.started', payload: { stepId: 's', kind: 'llm' }, labels: [] }
  expect(find(log([llmStep]))).not.toBeNull()
})

test('a call with an outcome.settled event is never served', () => {
  const settled: NewEvent = { type: 'outcome.settled', payload: { toolCallId: 'c1', outcome: 'happened' }, labels: [] }
  expect(find(log([settled]))).toBeNull()
})

test('a write sent while the read was in flight clears it', () => {
  const events = rawLog(
    [{ type: 'run.created', payload: { agentId: 'a', input: { text: 'hi' } }, labels: ['untrusted'] }, 0],
    [{ type: 'tool.requested', payload: { toolCallId: 'c1', tool: 'orders.get', args: { a: 1, b: 2 }, idempotencyKey: 'k' }, labels: [] }, 0],
    [sent('c2', 'payments.refund'), 0],
    [answered('c1'), 0],
  )
  expect(find(events)).toBeNull()
})
