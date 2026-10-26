import { z } from 'zod'
import { LimitNameSchema, LimitsSchema } from './limits'

export * from './limits'

export const LabelSchema = z.enum(['trusted', 'internal', 'untrusted', 'confidential'])
export type Label = z.infer<typeof LabelSchema>

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  argumentsError: z.string().optional(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  /** Context item that changes between calls (for example the time). Sent to the LLM, never stored in events. */
  volatile: z.boolean().optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const ToolSafetySchema = z.object({
  effect: z.enum(['read', 'write']),
  idempotency: z.boolean(),
  reachesOutside: z.boolean(),
  outputLabel: LabelSchema,
})
export type ToolSafety = z.infer<typeof ToolSafetySchema>

export const SupportSchema = z.enum(['principal', 'idempotency-key', 'dry-run'])
export type Support = z.infer<typeof SupportSchema>

export const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  safety: ToolSafetySchema,
  connectionId: z.string(),
  supports: z.array(SupportSchema).optional(),
  /** True when the definition changed after an admin last reviewed it: the tool never runs without approval. */
  changedSinceReview: z.boolean().optional(),
})
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>

export const ModelProfileSchema = z
  .object({
    jsonSchemaStrict: z.boolean(),
    parallelTools: z.boolean(),
    usageCost: z.boolean(),
    priceInPerMTok: z.number().nonnegative().optional(),
    priceOutPerMTok: z.number().nonnegative().optional(),
  })
  .strict()
export type ModelProfile = z.infer<typeof ModelProfileSchema>

export const DEFAULT_MODEL_PROFILE: ModelProfile = { jsonSchemaStrict: false, parallelTools: false, usageCost: false }

export const ConditionSchema = z
  .object({
    eq: z.unknown().optional(),
    ne: z.unknown().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    in: z.array(z.unknown()).optional(),
    not_in: z.array(z.unknown()).optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).length > 0, { message: 'condition needs at least one operator' })
export type Condition = z.infer<typeof ConditionSchema>

export const RuleSchema = z.object({
  tool: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/),
  when: z
    .record(z.string(), ConditionSchema)
    .refine((w) => Object.keys(w).length > 0, { message: 'when needs at least one key' })
    .optional(),
})
export type Rule = z.infer<typeof RuleSchema>

const StepIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/)
/** A value taken from the run input or from the output of an earlier step. No templates, no expressions. */
export const RefSchema = z.object({ $ref: z.string().regex(/^(\$input\.text|[a-z0-9_-]{1,64}(\.[A-Za-z0-9_-]+)*)$/) }).strict()
export type Ref = z.infer<typeof RefSchema>
/** The next step: one step id, or the first rule whose condition holds on the output of the step just done. */
const NextSchema = z.union([
  StepIdSchema,
  z
    .object({
      when: z.array(z.object({ field: z.string().min(1), is: ConditionSchema, goto: StepIdSchema }).strict()).min(1),
      else: StepIdSchema.optional(),
    })
    .strict(),
])
const next = { next: NextSchema.optional() }
export const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('llm'), prompt: z.string().min(1), output_schema: z.record(z.string(), z.unknown()).optional(), ...next }).strict(),
  z.object({ kind: z.literal('tool'), tool: z.string().min(1), args: z.record(z.string(), z.unknown()), ...next }).strict(),
  z.object({ kind: z.literal('approval'), reason: z.string().min(1).max(1000), ...next }).strict(),
  z.object({ kind: z.literal('subrun'), agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), input: z.union([z.string().min(1), RefSchema]), ...next }).strict(),
])
export type Step = z.infer<typeof StepSchema>
export const WorkflowSchema = z.object({ start: StepIdSchema, steps: z.record(StepIdSchema, StepSchema) }).strict()
export type Workflow = z.infer<typeof WorkflowSchema>

export const AgentDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    instructions: z.string().min(1),
    connections: z.array(z.string()),
    autonomy: z.literal('supervised'),
    allow: z.array(RuleSchema),
    model: z.string().default('default'),
    limits: LimitsSchema.optional(),
    workflows: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/), WorkflowSchema).optional(),
  })
  .strict()
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_human',
  'sleeping',
  'completed',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

// `breaker` is the old name of an `llm_calls` breach; only old logs carry it.
export const WaitingReasonSchema = z.enum(['approval', 'unknown_outcome', 'limit', 'breaker', 'handoff', 'input', 'escalated'])
export type WaitingReason = z.infer<typeof WaitingReasonSchema>

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

const payloadSchemas = {
  'run.created': z.object({
    agentId: z.string(),
    input: z.object({ text: z.string() }),
    principal: z.object({ id: z.string(), roles: z.array(z.string()) }).optional(),
    // A copy of the workflow when the run started: editing the agent does not change a running workflow.
    workflow: z.object({ name: z.string(), definition: WorkflowSchema }).optional(),
    // Set on a run that a workflow `subrun` step started.
    parent: z.object({ runId: z.string(), stepId: z.string() }).optional(),
  }),
  'llm.requested': z.object({
    model: z.string(),
    // Hash of the manifest of what was sent (see `snapshotRequest`). Old events have none.
    context: z.object({ snapshot: z.string(), chars: z.number() }).optional(),
  }),
  'llm.responded': z.object({
    message: MessageSchema,
    usage: UsageSchema,
    stopReason: z.enum(['end', 'tool_calls', 'length', 'filtered']),
  }),
  'rule.decided': z.object({
    toolCallId: z.string(),
    tool: z.string(),
    decision: z.enum(['allow', 'require_approval', 'deny']),
    reason: z.string(),
  }),
  'approval.requested': z.object({
    toolCallId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    reason: z.string(),
  }),
  'approval.resolved': z.object({
    toolCallId: z.string(),
    action: z.enum(['approve', 'reject']),
  }),
  'tool.requested': z.object({
    toolCallId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string(),
  }),
  'tool.responded': z.object({
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
  'outcome.settled': z.object({
    toolCallId: z.string(),
    outcome: z.enum(['happened', 'not_happened']),
  }),
  'run.state_changed': z.object({
    from: RunStatusSchema,
    to: RunStatusSchema,
    reason: z.string().optional(), // a WaitingReason or free text
    // ISO 8601; set when a run starts to wait for a human. A wait without it never expires.
    expiresAt: z.string().optional(),
    // ISO 8601; set when a run starts to sleep until a follow-up.
    wakeAt: z.string().optional(),
    // The question of `ask_human`, or the agent's reason for `escalate`; shown to the human who answers.
    question: z.string().optional(),
    escalation: z.string().optional(),
  }),
  // A connection guard made the call wait; the call has not been sent. `retryAt` is ISO 8601.
  'tool.deferred': z.object({
    toolCallId: z.string(),
    reason: z.enum(['rate', 'concurrency', 'breaker']),
    retryAt: z.string(),
  }),
  'step.started': z.object({ stepId: z.string(), kind: z.enum(['llm', 'tool', 'approval', 'subrun']) }),
  'step.completed': z.object({ stepId: z.string(), output: z.json() }),
  'limit.reached': z.object({ limit: LimitNameSchema, max: z.number(), value: z.number() }),
  'limit.continued': z.object({ limit: LimitNameSchema }),
  // What a human sends to a run that is not waiting for them: `message` steers it, `cancel` stops it before its next step.
  'input.received': z.union([
    z.object({ action: z.literal('cancel') }).strict(),
    z.object({ action: z.literal('message'), text: z.string().min(1).max(32_000) }).strict(),
  ]),
  // `retryAt` (ISO 8601) is set only by an LLM retry wait.
  'error.raised': z.object({ message: z.string(), retryable: z.boolean(), retryAt: z.string().optional() }),
} as const

export type EventPayloads = { [K in keyof typeof payloadSchemas]: z.infer<(typeof payloadSchemas)[K]> }
export type EventType = keyof EventPayloads

function eventSchema<K extends EventType>(type: K, payload: (typeof payloadSchemas)[K]) {
  return z.object({ type: z.literal(type), payload, labels: z.array(LabelSchema) })
}

export const NewEventSchema = z.discriminatedUnion('type', [
  eventSchema('run.created', payloadSchemas['run.created']),
  eventSchema('llm.requested', payloadSchemas['llm.requested']),
  eventSchema('llm.responded', payloadSchemas['llm.responded']),
  eventSchema('rule.decided', payloadSchemas['rule.decided']),
  eventSchema('approval.requested', payloadSchemas['approval.requested']),
  eventSchema('approval.resolved', payloadSchemas['approval.resolved']),
  eventSchema('tool.requested', payloadSchemas['tool.requested']),
  eventSchema('tool.responded', payloadSchemas['tool.responded']),
  eventSchema('outcome.settled', payloadSchemas['outcome.settled']),
  eventSchema('run.state_changed', payloadSchemas['run.state_changed']),
  eventSchema('error.raised', payloadSchemas['error.raised']),
  eventSchema('limit.reached', payloadSchemas['limit.reached']),
  eventSchema('limit.continued', payloadSchemas['limit.continued']),
  eventSchema('input.received', payloadSchemas['input.received']),
  eventSchema('tool.deferred', payloadSchemas['tool.deferred']),
  eventSchema('step.started', payloadSchemas['step.started']),
  eventSchema('step.completed', payloadSchemas['step.completed']),
])
export type NewEvent = z.infer<typeof NewEventSchema>

const storedFields = {
  tenantId: z.string(),
  runId: z.string(),
  seq: z.number().int(),
  agentVersion: z.number().int(),
  createdAt: z.string(),
  prevHash: z.string(),
  hash: z.string(),
}

export const StoredEventSchema = z.intersection(NewEventSchema, z.object(storedFields))
export type StoredEvent = NewEvent & z.infer<z.ZodObject<typeof storedFields>>
