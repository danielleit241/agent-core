import { describe, expect, test } from 'vitest'
import { ScenarioSchema } from '../src/scenario'

const base = { id: 'refund-over-limit', group: 'refund', description: 'd', input: { text: 'hi' }, expect: {} }

describe('ScenarioSchema', () => {
  test('applies defaults', () => {
    const s = ScenarioSchema.parse(base)
    expect(s.approvals).toEqual({})
    expect(s.expect.status).toBe('completed')
    expect(s.fixture).toBeUndefined()
  })

  test('rejects an unknown key at the top level and in expect', () => {
    expect(ScenarioSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(ScenarioSchema.safeParse({ ...base, expect: { nope: 1 } }).success).toBe(false)
  })

  test('accepts a waiting reason and rejects an unknown one', () => {
    expect(ScenarioSchema.parse({ ...base, expect: { status: 'waiting_human', waitingReason: 'input' } }).expect.waitingReason).toBe('input')
    expect(ScenarioSchema.safeParse({ ...base, expect: { waitingReason: 'bored' } }).success).toBe(false)
  })

  test('rejects a bad id and empty input text', () => {
    expect(ScenarioSchema.safeParse({ ...base, id: 'Bad_Id' }).success).toBe(false)
    expect(ScenarioSchema.safeParse({ ...base, input: { text: '' } }).success).toBe(false)
  })

  test('accepts a fixture and approvals', () => {
    const s = ScenarioSchema.parse({
      ...base,
      fixture: { orders: { '1': { status: 'delivered', amount: 5, customerId: 'c' } } },
      approvals: { 'payments.refund': 'approve' },
    })
    expect(s.approvals['payments.refund']).toBe('approve')
  })

  test('agent and timeoutS are optional; timeoutS is capped at 1800', () => {
    const s = ScenarioSchema.parse(base)
    expect(s.agent).toBeUndefined()
    expect(s.timeoutS).toBeUndefined()
    expect(ScenarioSchema.parse({ ...base, agent: 'long', timeoutS: 1800 }).timeoutS).toBe(1800)
    expect(ScenarioSchema.safeParse({ ...base, timeoutS: 1801 }).success).toBe(false)
  })

  test('accepts the peak and tool count expectations', () => {
    const s = ScenarioSchema.parse({ ...base, expect: { peakInputTokensAtMost: 500, toolCallCount: { 'orders.get': 1 } } })
    expect(s.expect.peakInputTokensAtMost).toBe(500)
    expect(s.expect.toolCallCount).toEqual({ 'orders.get': 1 })
  })
})
