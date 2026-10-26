import { DEFAULT_LIMITS, LimitsSchema, limitsAboveDefault, resolveLimits } from '../src/limits'
import { AgentDefinitionSchema } from '../src/types'

test('defaults are the conservative values', () => {
  expect(DEFAULT_LIMITS).toEqual({
    llm_calls: 30,
    tokens: 500_000,
    cost_usd: 1,
    tenant_cost_usd_per_day: 20,
    run_time_s: 1800,
    wait_human_s: 86_400,
    tool_output_chars: 48_000,
  })
})

test('resolveLimits fills every missing limit with its default', () => {
  expect(resolveLimits()).toEqual(DEFAULT_LIMITS)
  expect(resolveLimits({ llm_calls: 5 })).toEqual({ ...DEFAULT_LIMITS, llm_calls: 5 })
})

test.each([[{ llm_calls: 1.5 }], [{ tokens: 0 }], [{ cost_usd: -1 }], [{ foo: 1 }]])('limits schema rejects %j', (value) => {
  expect(LimitsSchema.safeParse(value).success).toBe(false)
})

test('limits schema accepts a fractional cost', () => {
  expect(LimitsSchema.safeParse({ cost_usd: 0.5 }).success).toBe(true)
})

test('limitsAboveDefault names only the limits set above their default', () => {
  expect(limitsAboveDefault({ llm_calls: 31, tokens: 10 })).toEqual(['llm_calls'])
  expect(limitsAboveDefault(undefined)).toEqual([])
})

test('an agent may carry a limits block', () => {
  const agent = { id: 'a', instructions: 'x', connections: [], autonomy: 'supervised', allow: [] }
  expect(AgentDefinitionSchema.parse({ ...agent, limits: { llm_calls: 3 } }).limits).toEqual({ llm_calls: 3 })
  expect(AgentDefinitionSchema.safeParse({ ...agent, limits: { llm_calls: 0 } }).success).toBe(false)
})
