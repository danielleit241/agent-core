import { ConfigRepo } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { startDeliveryWorker } from '@agent-core/webhooks'
import type { LLMPort } from '@agent-core/core'
import { buildApp } from './http/app'
import type { ProbeResult } from './http/routes/models'
import { createRunSettledHandler } from './runs/settled'
import { createToolRouter } from './tools/router'
import { startRunWorker } from './worker/worker'

export type ServiceStackDeps = {
  pool: ReturnType<typeof createPool>
  adminKey: string
  llm: LLMPort
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
  const config = new ConfigRepo(pool, 'default')
  const tools = createToolRouter(config)
  const app = buildApp({ pool, adminKey: deps.adminKey, models: deps.models, probe: deps.probe })
  const runWorker = startRunWorker({
    pool,
    llm: deps.llm,
    tools,
    workerId: deps.workerId,
    pollMs: deps.runPollMs,
    onRunSettled: createRunSettledHandler(pool),
  })
  const deliveryWorker = startDeliveryWorker({ pool, pollMs: deps.deliveryPollMs, delaysS: deps.deliveryDelaysS })
  return {
    app,
    /** Stops the app first, then the workers, then the invoker. */
    async close(): Promise<void> {
      await app.close()
      await Promise.all([runWorker.stop(), deliveryWorker.stop()])
      await tools.close()
    },
  }
}
