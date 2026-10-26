import type { AgentDefinition } from '@agent-core/core'
import type { ConfigRepo } from '@agent-core/store-postgres'

/** The agent a run uses when `POST /v1/runs` names none. It lives in code, not in the database: no tenant can change it. */
export const DEFAULT_AGENT: AgentDefinition = {
  id: 'default',
  instructions: [
    'You are a general assistant. You have no tools except the built-in ones.',
    'If you need information from the user to go on, ask with agent_core.ask_human.',
    'If the request is outside what you can do, hand it over with agent_core.escalate.',
    'Otherwise answer directly and briefly.',
  ].join(' '),
  connections: [],
  autonomy: 'supervised',
  allow: [],
  model: 'default',
}

export const DEFAULT_AGENT_VERSION = 0

export type ResolvedAgent = { definition: AgentDefinition; version: number }

/** Finds an agent of the tenant, or the built-in default agent for the reserved id `default`. */
export async function resolveAgent(config: ConfigRepo, id: string): Promise<ResolvedAgent | null> {
  if (id === DEFAULT_AGENT.id) return { definition: DEFAULT_AGENT, version: DEFAULT_AGENT_VERSION }
  return config.getAgent(id)
}
