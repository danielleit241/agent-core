import { z } from 'zod'

export const LIMIT_NAMES = [
  'llm_calls',
  'tokens',
  'cost_usd',
  'tenant_cost_usd_per_day',
  'run_time_s',
  'wait_human_s',
  'tool_output_chars',
  'loop',
] as const
export const LimitNameSchema = z.enum(LIMIT_NAMES)
export type LimitName = z.infer<typeof LimitNameSchema>

const count = z.number().int().positive()
const usd = z.number().positive()

export const LimitsSchema = z
  .object({
    llm_calls: count,
    tokens: count,
    cost_usd: usd,
    tenant_cost_usd_per_day: usd,
    run_time_s: count,
    wait_human_s: count,
    tool_output_chars: count,
    loop: count,
  })
  .partial()
  .strict()
export type Limits = Required<z.infer<typeof LimitsSchema>>

/** Safe defaults. A tenant key may only lower them; the admin key may raise them. */
export const DEFAULT_LIMITS: Limits = {
  llm_calls: 30,
  tokens: 500_000,
  cost_usd: 1,
  tenant_cost_usd_per_day: 20,
  run_time_s: 1800,
  wait_human_s: 86_400,
  // About 12k tokens: a large tool output would fill the LLM context and every later request.
  tool_output_chars: 48_000,
  // The same call allowed 3 times; also 3 tool turns in a row that bring nothing new.
  loop: 3,
}

export function resolveLimits(partial?: Partial<Limits>): Limits {
  return { ...DEFAULT_LIMITS, ...partial }
}

export function limitsAboveDefault(partial?: Partial<Limits>): LimitName[] {
  return LIMIT_NAMES.filter((name) => partial?.[name] !== undefined && partial[name] > DEFAULT_LIMITS[name])
}

/** Per-connection limits, shared by every run and worker of the tenant. */
export const ConnectionLimitsSchema = z.object({ calls_per_minute: count, concurrency: count }).partial().strict()
export type ConnectionLimits = Required<z.infer<typeof ConnectionLimitsSchema>>

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = { calls_per_minute: 60, concurrency: 4 }

/** The breaker opens after this many failed calls in a row, stays open for `openS`, then lets one trial call through. */
export const BREAKER = { failures: 5, openS: 30 } as const

export function resolveConnectionLimits(partial?: Partial<ConnectionLimits>): ConnectionLimits {
  return { ...DEFAULT_CONNECTION_LIMITS, ...partial }
}
