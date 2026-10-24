import { ConfigRepo } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { createMcpInvoker } from '@agent-core/tools-mcp'
import { startDeliveryWorker } from '@agent-core/webhooks'
import type { LLMPort } from '@agent-core/core'
import { buildApp } from './app'
import { createRunSettledHandler } from './settled'
import { startRunWorker } from './worker'

export type ServiceStackDeps = {
  pool: ReturnType<typeof createPool>
  adminKey: string
  llm: LLMPort
  workerId: string
  runPollMs?: number
  deliveryPollMs?: number
  deliveryDelaysS?: number[]
}

/** Wires the app, the MCP invoker, the run worker and the delivery worker. Does not own the pool. */
export function createServiceStack(deps: ServiceStackDeps) {
  const { pool } = deps
  const config = new ConfigRepo(pool, 'default')
  const tools = createMcpInvoker(async (connectionId) => {
    const connection = await config.getConnection(connectionId)
    if (!connection) throw new Error(`connection not found: ${connectionId}`)
    return connection.url
  })
  const app = buildApp({ pool, adminKey: deps.adminKey })
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
