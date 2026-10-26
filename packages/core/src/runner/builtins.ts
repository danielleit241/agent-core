import { z } from 'zod'
import { toolMatches } from '../policy/rules'
import type { AgentDefinition, ToolDescriptor } from '../types'

/** Names that only built-in tools may use. A connection may not register a tool with this prefix. */
export const BUILTIN_PREFIX = 'agent_core.'
export const FOLLOWUP_TOOL = 'agent_core.schedule_followup'
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

export const isBuiltin = (name: string): boolean => name.startsWith(BUILTIN_PREFIX)

/** The built-in tools an agent turned on: one of its allow rules must name the tool. */
export const builtinTools = (agent: AgentDefinition): ToolDescriptor[] =>
  [followup].filter((t) => agent.allow.some((rule) => toolMatches(rule.tool, t.name)))

export const parseFollowup = (args: Record<string, unknown>) => FollowupArgs.safeParse(args)
