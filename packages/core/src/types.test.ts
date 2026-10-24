import { AgentDefinitionSchema, ConditionSchema, NewEventSchema, RuleSchema } from './types'

test('event schema rejects unknown event types', () => {
  expect(NewEventSchema.safeParse({ type: 'run.exploded', payload: {}, labels: [] }).success).toBe(false)
})
test('event schema accepts a valid event', () => {
  expect(
    NewEventSchema.safeParse({ type: 'llm.requested', payload: { model: 'default' }, labels: ['trusted'] }).success,
  ).toBe(true)
})
test('agent definition defaults model to "default"', () => {
  const a = AgentDefinitionSchema.parse({ id: 'a', instructions: 'x', connections: [], autonomy: 'supervised', allow: [] })
  expect(a.model).toBe('default')
})
test('agent definition rejects autonomy other than supervised in M0', () => {
  expect(AgentDefinitionSchema.safeParse({ id: 'a', instructions: 'x', connections: [], autonomy: 'autonomous', allow: [] }).success).toBe(false)
})
test('agent definition rejects unknown fields', () => {
  expect(
    AgentDefinitionSchema.safeParse({ id: 'a', instructions: 'x', connections: [], autonomy: 'supervised', allow: [], extra: 1 }).success,
  ).toBe(false)
})
test('rule tool pattern accepts exact names and prefix wildcards only', () => {
  expect(RuleSchema.safeParse({ tool: 'orders.*' }).success).toBe(true)
  expect(RuleSchema.safeParse({ tool: '*.get' }).success).toBe(false)
})
test('condition rejects unknown operators', () => {
  expect(ConditionSchema.safeParse({ gte: 1 }).success).toBe(true)
  expect(ConditionSchema.safeParse({ regex: 'x' }).success).toBe(false)
})
test('condition needs at least one operator', () => {
  expect(ConditionSchema.safeParse({}).success).toBe(false)
  expect(ConditionSchema.safeParse({ exists: false }).success).toBe(true)
})
test('rule when, if present, needs at least one key', () => {
  expect(RuleSchema.safeParse({ tool: 'orders.get', when: {} }).success).toBe(false)
  expect(RuleSchema.safeParse({ tool: 'orders.get', when: { a: { eq: 1 } } }).success).toBe(true)
  expect(RuleSchema.safeParse({ tool: 'orders.get' }).success).toBe(true)
})
