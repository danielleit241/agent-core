import { withClaim, withTenant } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { startDeliveryWorker } from '@agent-core/webhooks'
import { secretAad } from '@agent-core/core'
import type { LLMPort, SecretBox } from '@agent-core/core'
import { buildApp } from './http/app'
import { metrics } from './metrics'
import type { ProbeResult } from './http/routes/models'
import { createRunSettledHandler } from './runs/settled'
import { createToolRouters } from './tools/router'
import { startRunWorker } from './worker/worker'

export type ServiceStackDeps = {
  pool: ReturnType<typeof createPool>
  /** SHA-256 of the admin key. */
  adminKeyHash: Buffer
  secrets: SecretBox
  /** Null when the LLM is not configured: runs are refused and the run worker does not start, so queued runs wait for a restart with LLM settings. */
  llm: LLMPort | null
  /** The LLM API key. Removed from run input, messages and tool output. */
  llmApiKey: string | undefined
  masterKeySource?: 'env' | 'file'
  /** Alias to real model id. */
  models?: Record<string, string>
  probe?: (model: string) => Promise<ProbeResult>
  workerId: string
  runPollMs?: number
  deliveryPollMs?: number
  deliveryDelaysS?: number[]
}

/** Wires the app, the tool router, the run worker and the delivery worker. Does not own the pool. */
export function createServiceStack(deps: ServiceStackDeps) {
  const { pool } = deps
  const llm: LLMPort = {
    async complete(req) {
      try {
        if (deps.llm === null) throw new Error('the LLM is not configured')
        const res = await deps.llm.complete(req)
        metrics.llmCall('ok', { input: res.usage.inputTokens, output: res.usage.outputTokens })
        return res
      } catch (err) {
        metrics.llmCall('error')
        throw err
      }
    },
  }
  const tools = createToolRouters(pool, deps.secrets)
  const app = buildApp({
    pool,
    adminKeyHash: deps.adminKeyHash,
    secrets: deps.secrets,
    models: deps.models,
    probe: deps.probe,
    llmConfigured: deps.llm !== null,
    masterKeySource: deps.masterKeySource,
    llmApiKey: deps.llmApiKey,
  })
  const runWorker = deps.llm === null ? null : startRunWorker({
    pool,
    secrets: deps.secrets,
    llm,
    llmApiKey: deps.llmApiKey,
    onRedacted: (redactions) => metrics.redacted(redactions),
    onCacheHit: () => metrics.toolCacheHit(),
    tools: tools.forTenant,
    workerId: deps.workerId,
    pollMs: deps.runPollMs,
    onRunSettled: createRunSettledHandler(pool),
  })
  const deliveryWorker = startDeliveryWorker({
    scope: { claim: (fn) => withClaim(pool, fn), tenant: (t, fn) => withTenant(pool, t, fn) },
    openSecret: (tenantId, webhookId, sealed) => deps.secrets.open(sealed, secretAad(tenantId, 'webhooks', webhookId)),
    pollMs: deps.deliveryPollMs,
    delaysS: deps.deliveryDelaysS,
  })
  return {
    app,
    /** Stops the app first, then the workers, then the invoker. */
    async close(): Promise<void> {
      await app.close()
      await Promise.all([runWorker?.stop(), deliveryWorker.stop()])
      await tools.close()
    },
  }
}
