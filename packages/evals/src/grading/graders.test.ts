import { describe, expect, test } from 'vitest'
import type { StoredEvent } from '@agent-core/core'
import { gradeDeterministic } from './graders'
import { ScenarioSchema } from '../scenario'
import type { Outcome } from '../scenario'

const scenario = (exp: object) =>
  ScenarioSchema.parse({ id: 's', group: 'g', description: 'd', input: { text: 'hi' }, expect: exp })

const toolEvent = (tool: string, args: Record<string, unknown>): StoredEvent => ({
  type: 'tool.requested',
  payload: { toolCallId: 'c1', tool, args, idempotencyKey: 'k' },
  labels: [],
  tenantId: 't',
  runId: 'r',
  seq: 1,
  agentVersion: 1,
  createdAt: '',
  prevHash: '',
  hash: '',
})

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  status: 'completed',
  events: [toolEvent('payments.refund', { order_id: '1042', amount: 1200000 })],
  output: 'done',
  shop: { orders: {}, inventory: {}, refunds: [{ orderId: '1042', amount: 1200000 }], sizeChanges: [] },
  ...over,
})

describe('gradeDeterministic', () => {
  test('status', () => {
    expect(gradeDeterministic(scenario({}), outcome())).toEqual([])
    expect(gradeDeterministic(scenario({}), outcome({ status: 'failed' }))).toEqual([
      'status: expected completed, got failed',
    ])
  })

  test('toolsCalled matches tool and a subset of args', () => {
    const ok = scenario({ toolsCalled: [{ tool: 'payments.refund', args: { amount: 1200000 } }] })
    expect(gradeDeterministic(ok, outcome())).toEqual([])
    expect(gradeDeterministic(scenario({ toolsCalled: [{ tool: 'payments.refund' }] }), outcome())).toEqual([])
  })

  test('toolsCalled fails on a missing tool or a different arg', () => {
    expect(gradeDeterministic(scenario({ toolsCalled: [{ tool: 'orders.get' }] }), outcome())).toHaveLength(1)
    const wrongArg = scenario({ toolsCalled: [{ tool: 'payments.refund', args: { amount: 1 } }] })
    expect(gradeDeterministic(wrongArg, outcome())).toHaveLength(1)
  })

  test('toolsNotCalled', () => {
    expect(gradeDeterministic(scenario({ toolsNotCalled: ['orders.get'] }), outcome())).toEqual([])
    expect(gradeDeterministic(scenario({ toolsNotCalled: ['payments.refund'] }), outcome())).toEqual([
      'toolsNotCalled: payments.refund was called',
    ])
  })

  test('state.refunds is an exact match', () => {
    const want = (refunds: object[]) => scenario({ state: { refunds } })
    expect(gradeDeterministic(want([{ orderId: '1042', amount: 1200000 }]), outcome())).toEqual([])
    expect(gradeDeterministic(want([]), outcome())).toHaveLength(1)
  })

  test('state.sizeChanges is an exact match', () => {
    const o = outcome({
      shop: { orders: {}, inventory: {}, refunds: [], sizeChanges: [{ orderId: '1042', from: 'M', to: 'L' }] },
    })
    const want = (sizeChanges: object[]) => scenario({ state: { sizeChanges } })
    expect(gradeDeterministic(want([{ orderId: '1042', from: 'M', to: 'L' }]), o)).toEqual([])
    expect(gradeDeterministic(want([{ orderId: '1042', to: 'L' }]), o)).toHaveLength(1)
  })
})
