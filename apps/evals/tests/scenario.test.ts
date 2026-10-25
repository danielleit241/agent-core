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
})
