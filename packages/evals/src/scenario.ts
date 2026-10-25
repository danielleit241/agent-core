import { z } from 'zod'
import { RunStatusSchema } from '@agent-core/core'
import type { RunStatus, StoredEvent } from '@agent-core/core'
import type { startShop } from '@agent-core/shop'

type Shop = Awaited<ReturnType<typeof startShop>>

const OrderSchema = z
  .object({
    status: z.string(),
    amount: z.number(),
    customerId: z.string(),
    sku: z.string().optional(),
    size: z.string().optional(),
  })
  .strict()

export const ShopSeedSchema = z
  .object({
    orders: z.record(z.string(), OrderSchema),
    inventory: z.record(z.string(), z.number()).optional(), // key: `${sku}:${size}`
  })
  .strict()

const RefundSchema = z.object({ orderId: z.string(), amount: z.number() }).strict()
const SizeChangeSchema = z.object({ orderId: z.string(), from: z.string().optional(), to: z.string() }).strict()

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    group: z.string().min(1),
    description: z.string(),
    input: z.object({ text: z.string().min(1) }),
    principal: z.object({ id: z.string(), roles: z.array(z.string()) }).optional(),
    fixture: ShopSeedSchema.optional(), // omitted: default seed
    approvals: z.record(z.string(), z.enum(['approve', 'reject'])).default({}), // unlisted tool: 'reject'
    expect: z
      .object({
        status: RunStatusSchema.default('completed'),
        toolsCalled: z
          .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }))
          .optional(),
        toolsNotCalled: z.array(z.string()).optional(),
        state: z
          .object({
            refunds: z.array(RefundSchema).optional(),
            sizeChanges: z.array(SizeChangeSchema).optional(),
          })
          .optional(),
        rubric: z.string().optional(),
      })
      .strict(),
  })
  .strict()
export type Scenario = z.infer<typeof ScenarioSchema>

export type Outcome = {
  status: RunStatus
  events: StoredEvent[]
  output: string | null
  shop: ReturnType<Shop['snapshot']>
}

export type Result = {
  id: string
  group: string
  verdict: 'pass' | 'fail' | 'error'
  failures: string[]
  /** Tokens and cost of the agent's LLM calls (the rubric judge is not counted). */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
  ms?: number
  /** Set when the scenario ran more than once (`--repeat`). */
  runs?: { passed: number; total: number }
}
