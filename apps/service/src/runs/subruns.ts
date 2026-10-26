import { randomUUID } from 'node:crypto'
import { projectRun } from '@agent-core/core'
import type { SecretBox, SubrunPort } from '@agent-core/core'
import { ConfigRepo, PgRunStore, createRunWithEvent, getRun } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'

type Pool = ReturnType<typeof createPool>

/** Child runs of one tenant's workflow `subrun` steps. The idempotency key makes `start` return the same child when called again. */
export function createSubruns(pool: Pool, secrets: SecretBox, tenantId: string): SubrunPort {
  return {
    async start({ agentId, input, parent, principal }) {
      const agent = await new ConfigRepo(pool, tenantId, secrets).getAgent(agentId)
      if (!agent) throw new Error(`subrun agent not found: ${agentId}`)
      const created = await createRunWithEvent(pool, {
        tenantId,
        runId: `run_${randomUUID()}`,
        agentId,
        agentVersion: agent.version,
        idempotencyKey: `subrun:${parent.runId}:${parent.stepId}`,
        // The input comes from an earlier step, which may hold untrusted text.
        created: { type: 'run.created', payload: { agentId, input: { text: input }, parent, ...(principal === undefined ? {} : { principal }) }, labels: ['untrusted'] },
      })
      return created.id
    },
    async status(runId) {
      const run = await getRun(pool, tenantId, runId)
      if (!run) return null
      const events = await new PgRunStore(pool, tenantId).readEvents(runId)
      return { status: run.status, text: events.length > 0 ? projectRun(events, '').output : null }
    },
  }
}
