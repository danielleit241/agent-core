import { z } from 'zod'
import { toolMatches } from '../policy/rules'
import type { AgentDefinition, ToolDescriptor } from '../types'

/** Names that only built-in tools may use. A connection may not register a tool with this prefix. */
export const BUILTIN_PREFIX = 'agent_core.'
export const FOLLOWUP_TOOL = 'agent_core.schedule_followup'
export const ASK_HUMAN_TOOL = 'agent_core.ask_human'
export const ESCALATE_TOOL = 'agent_core.escalate'
/** Follow-ups one run may schedule. A fixed safety cap, not a limit a human can raise. */
export const MAX_FOLLOWUPS = 10

const MIN_AFTER_S = 60
const MAX_AFTER_S = 2_592_000 // 30 days

const followup: ToolDescriptor = {
  name: FOLLOWUP_TOOL,
  description:
    'Pause this run and continue it later, for example to check again on something that takes time. ' +
    'The run sleeps for after_seconds; then you get your note back and continue.',
  inputSchema: {
    type: 'object',
    properties: {
      after_seconds: { type: 'integer', minimum: MIN_AFTER_S, maximum: MAX_AFTER_S, description: 'How long to sleep, in seconds.' },
      note: { type: 'string', maxLength: 1000, description: 'What to do when the run wakes up.' },
    },
    required: ['after_seconds', 'note'],
    additionalProperties: false,
  },
  // `untrusted`: the model writes the note and may copy it from untrusted text.
  safety: { effect: 'write', idempotency: true, reachesOutside: false, outputLabel: 'untrusted' },
  connectionId: 'agent_core',
}

const FollowupArgs = z
  .object({ after_seconds: z.number().int().min(MIN_AFTER_S).max(MAX_AFTER_S), note: z.string().max(1000) })
  .strict()

const MAX_TEXT = 2000

const textTool = (name: string, description: string, field: 'question' | 'reason', fieldDescription: string): ToolDescriptor => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: { [field]: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: fieldDescription } },
    required: [field],
    additionalProperties: false,
  },
  // `untrusted`: a human's answer becomes the result, and the model may copy untrusted text into the argument.
  safety: { effect: 'read', idempotency: true, reachesOutside: false, outputLabel: 'untrusted' },
  connectionId: 'agent_core',
})

const askHuman = textTool(
  ASK_HUMAN_TOOL,
  'Ask the user a question and wait for the answer. Use it when you need information you do not have and cannot get from a tool, ' +
    'for example an order number the user did not give. The run continues with the answer as the result.',
  'question',
  'The question to ask the user.',
)

const escalate = textTool(
  ESCALATE_TOOL,
  'Hand the request to a human because you cannot or may not do it, for example when it is outside your scope or your tools cannot do it. ' +
    'Call this instead of replying with a refusal: a human then takes over. Do not guess or answer from memory instead. The run waits for a human.',
  'reason',
  'Why a human must take over.',
)

const TextArgs = {
  question: z.object({ question: z.string().min(1).max(MAX_TEXT) }).strict(),
  reason: z.object({ reason: z.string().min(1).max(MAX_TEXT) }).strict(),
}

export const isBuiltin = (name: string): boolean => name.startsWith(BUILTIN_PREFIX)

/** Every agent has `ask_human` and `escalate`; the others are on when one of its allow rules names the tool. */
export const builtinTools = (agent: AgentDefinition): ToolDescriptor[] => [
  askHuman,
  escalate,
  ...[followup].filter((t) => agent.allow.some((rule) => toolMatches(rule.tool, t.name))),
]

export const parseFollowup = (args: Record<string, unknown>) => FollowupArgs.safeParse(args)

/**
 * What a wait-for-human built-in adds to the state event, or null when its arguments are invalid.
 * `reason` of the state event is the waiting reason, so the agent's own reason goes under `escalation`.
 */
export function parseHumanWait(name: string, args: Record<string, unknown>): { reason: 'input' | 'escalated'; extra: Record<string, string> } | null {
  if (name === ASK_HUMAN_TOOL) {
    const r = TextArgs.question.safeParse(args)
    return r.success ? { reason: 'input', extra: { question: r.data.question } } : null
  }
  const r = TextArgs.reason.safeParse(args)
  return r.success ? { reason: 'escalated', extra: { escalation: r.data.reason } } : null
}
