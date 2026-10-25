import type { AgentDefinition, Rule, ToolDescriptor } from '../../src/types'
import { decide } from '../../src/policy/rules'

function toolWith(name: string, effect: 'read' | 'write'): ToolDescriptor {
  return {
    name,
    description: name,
    inputSchema: {},
    safety: { effect, idempotency: false, reachesOutside: false, outputLabel: 'trusted' },
    connectionId: 'c1',
  }
}

function agentWith(allow: Rule[]): AgentDefinition {
  return { id: 'a', instructions: 'x', connections: [], autonomy: 'supervised', allow, model: 'default' }
}

const REQ = { decision: 'require_approval', reason: 'write_requires_approval' }
const ALLOW0 = { decision: 'allow', reason: 'allow[0]' }

const refund = toolWith('payments.refund', 'write')
const agent = agentWith([{ tool: 'payments.refund', when: { amount: { lte: 1000000 } } }])

test.each([
  [toolWith('orders.get', 'read'), {}, 'allow', 'read'],
  [refund, { amount: 500000 }, 'allow', 'allow[0]'],
  [refund, { amount: 1000000 }, 'allow', 'allow[0]'],
  [refund, { amount: 1200000 }, 'require_approval', 'write_requires_approval'],
  [refund, { amount: '500000' }, 'require_approval', 'write_requires_approval'],
  [refund, {}, 'require_approval', 'write_requires_approval'],
  [refund, { amount: NaN }, 'require_approval', 'write_requires_approval'],
  [refund, { amount: Infinity }, 'require_approval', 'write_requires_approval'],
  [refund, { amount: -Infinity }, 'require_approval', 'write_requires_approval'],
])('decide(%s, %j)', (tool, args, decision, reason) => {
  expect(decide({ tool, args, agent })).toEqual({ decision, reason })
})

test('prefix wildcard matches only within the namespace', () => {
  const a = agentWith([{ tool: 'payments.*' }])
  expect(decide({ tool: toolWith('payments.refund', 'write'), args: {}, agent: a }).decision).toBe('allow')
  expect(decide({ tool: toolWith('paymentsx.refund', 'write'), args: {}, agent: a }).decision).toBe('require_approval')
  expect(decide({ tool: toolWith('payments', 'write'), args: {}, agent: a }).decision).toBe('require_approval')
})

test('a rule for another tool does not match', () => {
  const a = agentWith([{ tool: 'orders.cancel' }])
  expect(decide({ tool: refund, args: {}, agent: a })).toEqual(REQ)
})

test('reports the index of the first matching rule', () => {
  const a = agentWith([{ tool: 'orders.cancel' }, { tool: 'payments.refund' }])
  expect(decide({ tool: refund, args: {}, agent: a })).toEqual({ decision: 'allow', reason: 'allow[1]' })
})

const run = (when: Rule['when'], args: Record<string, unknown>) =>
  decide({ tool: refund, args, agent: agentWith([{ tool: 'payments.refund', when }]) })

describe('operators', () => {
  test('eq uses === for primitives and deep equality for objects', () => {
    expect(run({ k: { eq: 'a' } }, { k: 'a' })).toEqual(ALLOW0)
    expect(run({ k: { eq: 'a' } }, { k: 'b' })).toEqual(REQ)
    expect(run({ k: { eq: 1 } }, { k: '1' })).toEqual(REQ)
    expect(run({ k: { eq: { a: [1, 2] } } }, { k: { a: [1, 2] } })).toEqual(ALLOW0)
    expect(run({ k: { eq: [1, 2] } }, { k: [1, 3] })).toEqual(REQ)
  })
  test('ne', () => {
    expect(run({ k: { ne: 'a' } }, { k: 'b' })).toEqual(ALLOW0)
    expect(run({ k: { ne: 'a' } }, { k: 'a' })).toEqual(REQ)
    expect(run({ k: { ne: 'a' } }, {})).toEqual(REQ)
  })
  test('in and not_in', () => {
    expect(run({ k: { in: ['a', 'b'] } }, { k: 'b' })).toEqual(ALLOW0)
    expect(run({ k: { in: ['a', 'b'] } }, { k: 'c' })).toEqual(REQ)
    expect(run({ k: { in: [{ x: 1 }] } }, { k: { x: 1 } })).toEqual(ALLOW0)
    expect(run({ k: { not_in: ['a', 'b'] } }, { k: 'c' })).toEqual(ALLOW0)
    expect(run({ k: { not_in: ['a', 'b'] } }, { k: 'a' })).toEqual(REQ)
    expect(run({ k: { not_in: ['a'] } }, {})).toEqual(REQ)
  })
  test('lt, lte, gt, gte', () => {
    expect(run({ k: { gt: 5 } }, { k: 6 })).toEqual(ALLOW0)
    expect(run({ k: { gt: 5 } }, { k: 5 })).toEqual(REQ)
    expect(run({ k: { gte: 5 } }, { k: 5 })).toEqual(ALLOW0)
    expect(run({ k: { lt: 5 } }, { k: 4 })).toEqual(ALLOW0)
    expect(run({ k: { lt: 5 } }, { k: 5 })).toEqual(REQ)
    expect(run({ k: { gt: 5 } }, { k: '6' })).toEqual(REQ)
    expect(run({ k: { gt: 5 } }, { k: Infinity })).toEqual(REQ)
  })
  test('exists true and false', () => {
    expect(run({ k: { exists: true } }, { k: 0 })).toEqual(ALLOW0)
    expect(run({ k: { exists: true } }, { k: null })).toEqual(ALLOW0)
    expect(run({ k: { exists: true } }, { k: undefined })).toEqual(REQ)
    expect(run({ k: { exists: true } }, {})).toEqual(REQ)
    expect(run({ k: { exists: false } }, {})).toEqual(ALLOW0)
    expect(run({ k: { exists: false } }, { k: undefined })).toEqual(ALLOW0)
    expect(run({ k: { exists: false } }, { k: 1 })).toEqual(REQ)
  })
  test('inherited keys do not count', () => {
    expect(run({ amount: { exists: true } }, {})).toEqual(REQ)
    expect(run({ toString: { exists: true } }, {})).toEqual(REQ)
    expect(run({ constructor: { exists: false } }, {})).toEqual(ALLOW0)
  })
})

describe('combining', () => {
  test('two operators on one key must both hold', () => {
    const when = { k: { gte: 1, lte: 10 } }
    expect(run(when, { k: 5 })).toEqual(ALLOW0)
    expect(run(when, { k: 0 })).toEqual(REQ)
    expect(run(when, { k: 11 })).toEqual(REQ)
  })
  test('two keys must both hold', () => {
    const when = { a: { eq: 1 }, b: { eq: 2 } }
    expect(run(when, { a: 1, b: 2 })).toEqual(ALLOW0)
    expect(run(when, { a: 1, b: 3 })).toEqual(REQ)
    expect(run(when, { a: 1 })).toEqual(REQ)
  })
})

describe('degenerate input fails closed', () => {
  test('malformed conditions never match', () => {
    expect(run({ amount: {} }, { amount: 1 })).toEqual(REQ)
    expect(run({ amount: {} }, {})).toEqual(REQ)
    expect(run({ amount: { bogus: 1 } } as unknown as Rule['when'], { amount: 1 })).toEqual(REQ)
    expect(run({ amount: { eq: 1, bogus: 1 } } as unknown as Rule['when'], { amount: 1 })).toEqual(REQ)
    expect(run({ amount: { in: 'x' } } as unknown as Rule['when'], { amount: 'x' })).toEqual(REQ)
    expect(run({ amount: { not_in: 'x' } } as unknown as Rule['when'], { amount: 'y' })).toEqual(REQ)
    expect(run({ amount: null } as unknown as Rule['when'], { amount: 1 })).toEqual(REQ)
    expect(run({ amount: 5 } as unknown as Rule['when'], { amount: 5 })).toEqual(REQ)
    expect(run({ amount: [] } as unknown as Rule['when'], { amount: 5 })).toEqual(REQ)
  })
  test('an empty when does not match', () => {
    expect(run({}, {})).toEqual(REQ)
    expect(run({}, { amount: 1 })).toEqual(REQ)
  })
  test('a cyclic or non-plain arg value does not throw', () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(run({ k: { eq: 1 } }, { k: cyc })).toEqual(REQ)
    expect(run({ k: { eq: cyc } }, { k: cyc })).toEqual(ALLOW0)
    expect(run({ k: { eq: new Date(0) } }, { k: new Date(0) })).toEqual(REQ)
  })
})

describe('a tool that changed since it was reviewed', () => {
  const changed = { ...refund, changedSinceReview: true }

  test('needs approval even when an allow rule matches', () => {
    expect(decide({ tool: changed, args: { amount: 5 }, agent })).toEqual({ decision: 'require_approval', reason: 'tool_changed_since_review' })
  })

  test('needs approval even when it is a read', () => {
    expect(decide({ tool: { ...toolWith('orders.get', 'read'), changedSinceReview: true }, args: {}, agent })).toMatchObject({
      decision: 'require_approval',
    })
  })

  test('changedSinceReview false changes nothing', () => {
    expect(decide({ tool: { ...refund, changedSinceReview: false }, args: { amount: 5 }, agent })).toEqual(ALLOW0)
  })
})
