import { projectRun } from '../../src/events/projection'
import { messageChars } from '../../src/content/snapshot'
import { compactionStub, handleOf } from '../../src/content/offload'
import { planCompaction } from '../../src/runner/compaction'
import type { Label, Message, NewEvent, StoredEvent } from '../../src/types'

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

const created: NewEvent = { type: 'run.created', payload: { agentId: 'a', input: { text: 'hi' } }, labels: ['untrusted'] }
const running: NewEvent = { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] }
const callMessage = (id: string, name = 'shipments.get'): Message => ({ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: { id } }] })
const responded = (message: Message, inputTokens = 1): NewEvent => ({
  type: 'llm.responded',
  payload: { message, usage: { inputTokens, outputTokens: 1 }, stopReason: 'tool_calls' },
  labels: [],
})
const toolResult = (id: string, content: string, labels: Label[] = ['internal']): NewEvent => ({
  type: 'tool.responded',
  payload: { toolCallId: id, content, isError: false },
  labels,
})

/**
 * Earlier turns with the given result sizes, then one measured call (`chars` sent, `tokens` read) whose response and
 * result add exactly `added` characters. The result of the measured turn is the latest assistant turn: protected.
 */
function log(o: { results: number[]; chars: number | null; tokens: number; added: number; extra?: NewEvent[]; tools?: Record<number, string>; late?: NewEvent[] }): StoredEvent[] {
  const events: NewEvent[] = [created, running]
  o.results.forEach((len, i) => events.push(responded(callMessage(`c${i}`, o.tools?.[i])), toolResult(`c${i}`, 'x'.repeat(len))))
  events.push({
    type: 'llm.requested',
    payload: { model: 'm', ...(o.chars === null ? {} : { context: { snapshot: 's', chars: o.chars } }) },
    labels: [],
  })
  const last = callMessage('last')
  events.push(responded(last, o.tokens), toolResult('last', 'y'.repeat(o.added - messageChars(last))), ...(o.late ?? []), ...(o.extra ?? []))
  return stored(events)
}

const idsOf = (plan: ReturnType<typeof planCompaction>) => plan?.clear.map((c) => c.toolCallId)
// 12,000 tokens estimated: T = 10,000 for C = 40,000 characters, plus 8,000 new characters at 0.25 token each.
const at12k = (results: number[]) => projectRun(log({ results, chars: 40_000, tokens: 10_000, added: 8_000 }), 'x')

test('no compaction without a previous request size and its usage', () => {
  expect(planCompaction(projectRun(log({ results: [4000, 4000], chars: null, tokens: 10_000, added: 8_000 }), 'x'), 1)).toBeNull()
  expect(planCompaction(projectRun(stored([created, running]), 'x'), 1)).toBeNull()
})

test('compacts at the threshold by the measured tokens-per-character ratio, not below', () => {
  const proj = at12k([4000, 4000])
  expect(planCompaction(proj, 12_000)).not.toBeNull()
  expect(planCompaction(proj, 12_001)).toBeNull()
  expect(planCompaction(proj, 12_000)!.estimatedBefore).toBe(12_000)
})

test('clears the oldest first, until the estimate is at most half the threshold', () => {
  const plan = planCompaction(at12k(Array(8).fill(4000)), 12_000)!
  // Each clear saves about 969 tokens: six clears leave 6,186, the seventh gets under 6,000.
  expect(idsOf(plan)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
  expect(plan.estimatedAfter).toBeLessThanOrEqual(6_000)
  expect(plan.estimatedAfter).toBeGreaterThan(5_000)
  expect(plan.clear[0]!.content).toBe('x'.repeat(4000))
})

test('skips the latest turn, short results and existing stubs; never offers other roles', () => {
  const proj = at12k([4000, 300, 301, 4000])
  const plan = planCompaction(proj, 12_000)!
  expect(idsOf(plan)).not.toContain('last')
  expect(idsOf(plan)).not.toContain('c1')
  expect(idsOf(plan)).toEqual(expect.arrayContaining(['c0', 'c2', 'c3']))
  const roles = new Map(proj.messages.filter((m) => m.toolCallId !== undefined).map((m) => [m.toolCallId, m.role]))
  expect(plan.clear.every((c) => roles.get(c.toolCallId) === 'tool')).toBe(true)

  const handle = handleOf('a'.repeat(64))
  const compacted: NewEvent = {
    type: 'context.compacted',
    payload: { estimatedBefore: 12_000, estimatedAfter: 11_000, threshold: 12_000, cleared: [{ toolCallId: 'c0', handle, hash: 'a'.repeat(64), chars: 4000 }] },
    labels: [],
  }
  // The compaction left the estimate at the threshold (a lower threshold now): c0 is a stub and is not offered again.
  const again = planCompaction(projectRun(log({ results: [4000, 4000], chars: 40_000, tokens: 10_000, added: 8_000, extra: [compacted] }), 'x'), 10_000)!
  expect(idsOf(again)).toEqual(['c1'])
})

test('when the candidates run out it clears all of them and reports the higher estimate; with none it is null', () => {
  const plan = planCompaction(at12k([4000, 4000]), 12_000)!
  expect(idsOf(plan)).toEqual(['c0', 'c1'])
  expect(plan.estimatedAfter).toBeGreaterThan(6_000)
  expect(plan.estimatedAfter).toBeLessThan(plan.estimatedBefore)
  expect(planCompaction(at12k([200, 300]), 12_000)).toBeNull()
  expect(planCompaction(at12k([]), 12_000)).toBeNull()
})

test('a result that was offloaded is cleared by its preview and its stub says the full size', () => {
  const hash = 'b'.repeat(64)
  const events = log({ results: [], chars: 40_000, tokens: 10_000, added: 8_000 })
  const offloaded: NewEvent[] = [
    responded(callMessage('big')),
    {
      type: 'tool.responded',
      payload: { toolCallId: 'big', content: 'p'.repeat(2000), isError: false, offload: { handle: handleOf(hash), hash, chars: 900_000, lines: 10 } },
      labels: ['confidential'],
    },
  ]
  // The offloaded turn comes before the measured call.
  const all = stored([...events.slice(0, 2), ...offloaded, ...events.slice(2)])
  const plan = planCompaction(projectRun(all, 'x'), 12_000)!
  expect(idsOf(plan)).toEqual(['big'])
  expect(plan.clear[0]!.content).toBe('p'.repeat(2000))
})

test('the stub text names the handle and the size with thousands separators', () => {
  expect(compactionStub('out_3f9a1c2b7d4e', 12345)).toBe(
    '[Output cleared to keep the context small: out_3f9a1c2b7d4e, 12,345 characters. You have already read it; call agent_core.read_output only for a detail you did not note.]',
  )
})

test('human answers (ask_human, escalate) are never cleared, however large and old', () => {
  const proj = projectRun(log({ results: [4000, 4000, 4000, 4000], chars: 40_000, tokens: 10_000, added: 8_000, tools: { 0: 'agent_core.ask_human', 2: 'agent_core.escalate' } }), 'x')
  expect(idsOf(planCompaction(proj, 12_000))).toEqual(['c1', 'c3'])
})

test('without usable input tokens the estimate falls back to a quarter of the characters, so compaction stays on', () => {
  // 40,000 + 8,000 characters at 0.25 token each: 12,000.
  for (const tokens of [0, Number.NaN]) {
    const plan = planCompaction(projectRun(log({ results: [4000, 4000], chars: 40_000, tokens, added: 8_000 }), 'x'), 12_000)
    expect(plan?.estimatedBefore).toBe(12_000)
  }
  expect(planCompaction(projectRun(log({ results: [4000], chars: 40_000, tokens: 0, added: 8_000 }), 'x'), 12_001)).toBeNull()
})

test('the read_output descriptor joins the estimate when the next request will carry it and the measured one did not', () => {
  const hash = 'c'.repeat(64)
  const late: NewEvent[] = [
    { type: 'tool.responded', payload: { toolCallId: 'late', content: 'p', isError: false, offload: { handle: handleOf(hash), hash, chars: 9_000, lines: 1 } }, labels: ['internal'] },
  ]
  const base = { results: [4000, 4000], chars: 40_000, tokens: 10_000, added: 8_000 }
  // No handle yet: the descriptor appears only once compaction makes one, so it counts in the estimate after the clear.
  const none = projectRun(log(base), 'x')
  expect(planCompaction(none, 12_000, 400)!.estimatedAfter - planCompaction(none, 12_000, 0)!.estimatedAfter).toBe(100)
  expect(planCompaction(none, 12_000, 400)!.estimatedBefore).toBe(12_000)
  // A handle appeared after the measured call: the next request carries the descriptor already, so it counts before the clear too.
  const withHandle = projectRun(log({ ...base, late }), 'x')
  const delta = planCompaction(withHandle, 12_000, 400)!.estimatedBefore - planCompaction(withHandle, 12_000, 0)!.estimatedBefore
  expect(delta).toBe(100)
})
