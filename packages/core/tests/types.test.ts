import {
  AgentDefinitionSchema,
  ConditionSchema,
  DEFAULT_MODEL_PROFILE,
  ModelProfileSchema,
  NewEventSchema,
  RuleSchema,
  ToolDescriptorSchema,
} from '../src/types'

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

test('outcome.settled event accepts happened and not_happened only', () => {
  const ev = (outcome: string) => ({ type: 'outcome.settled', payload: { toolCallId: 'c1', outcome }, labels: [] })
  expect(NewEventSchema.safeParse(ev('happened')).success).toBe(true)
  expect(NewEventSchema.safeParse(ev('not_happened')).success).toBe(true)
  expect(NewEventSchema.safeParse(ev('maybe')).success).toBe(false)
})
test('model profile is strict, validates prices and has a closed default', () => {
  expect(ModelProfileSchema.parse(DEFAULT_MODEL_PROFILE)).toEqual(DEFAULT_MODEL_PROFILE)
  expect(DEFAULT_MODEL_PROFILE).toEqual({ jsonSchemaStrict: false, parallelTools: false, usageCost: false })
  const ok = { ...DEFAULT_MODEL_PROFILE, priceInPerMTok: 1.5, priceOutPerMTok: 0 }
  expect(ModelProfileSchema.safeParse(ok).success).toBe(true)
  expect(ModelProfileSchema.safeParse({ ...ok, priceInPerMTok: -1 }).success).toBe(false)
  expect(ModelProfileSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  expect(ModelProfileSchema.safeParse({ jsonSchemaStrict: true }).success).toBe(false)
})
test('tool descriptor supports is optional and limited to known values', () => {
  const base = {
    name: 't',
    description: 'd',
    inputSchema: {},
    safety: { effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'internal' },
    connectionId: 'c',
  }
  expect(ToolDescriptorSchema.safeParse(base).success).toBe(true)
  expect(ToolDescriptorSchema.safeParse({ ...base, supports: ['principal', 'idempotency-key', 'dry-run'] }).success).toBe(true)
  expect(ToolDescriptorSchema.safeParse({ ...base, supports: ['teleport'] }).success).toBe(false)
})
