import { readFile, readdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createSecretBox } from '@agent-core/core'
import type { LLMPort } from '@agent-core/core'
import { createServiceStack, hashAdminKey } from '@agent-core/service'
import { assertTestDatabase, assertTestPool, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { startShop } from '@agent-core/shop'
import { withoutLlmRetry } from './no-llm-retry'

const ADMIN_KEY = 'eval-admin-key'
const AGENT_DIR = fileURLToPath(new URL('../../agents', import.meta.url))

export type EvalStack = {
  shop: Awaited<ReturnType<typeof startShop>>
  // JSON bodies are checked ad hoc by the runner, so `body` stays loosely typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>
  close(): Promise<void>
}

/** Resets the test database, then starts the shop and the service with connections `shop`, `warehouse` and `logistics` and every agent in `agents/`. */
export async function startEvalStack(opts: { llm: LLMPort }): Promise<EvalStack> {
  const databaseUrl =
    process.env.EVAL_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
  assertTestDatabase(databaseUrl) // the reset below drops every table
  const migrator = createPool(databaseUrl)
  const pool = createPool(runtimeTestUrl(databaseUrl))
  let shop: EvalStack['shop'] | undefined
  let service: ReturnType<typeof createServiceStack> | undefined
  try {
    await assertTestPool(migrator)
    await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
    await migrator.end()
    shop = await startShop()
    service = createServiceStack({
      pool,
      adminKeyHash: hashAdminKey(ADMIN_KEY),
      secrets: createSecretBox(Buffer.alloc(32, 7)),
      llm: withoutLlmRetry(opts.llm),
      llmApiKey: process.env.LLM_API_KEY,
      workerId: 'eval-worker',
      runPollMs: 20,
      deliveryPollMs: 1000,
    })
    await service.app.listen({ port: 0, host: '127.0.0.1' })
    const baseUrl = `http://127.0.0.1:${(service.app.server.address() as AddressInfo).port}`

    const api: EvalStack['api'] = async (method, path, body) => {
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: text === '' ? undefined : JSON.parse(text) }
    }
    // Evals run the agent as a team would after confirming every proposed safety value.
    for (const [id, url] of [
      ['shop', shop.url],
      ['warehouse', shop.warehouseUrl],
      ['logistics', shop.logisticsUrl],
    ] as const) {
      const conn = await api('POST', '/v1/connections', { id, url })
      if (conn.status >= 300) throw new Error(`registering connection ${id} failed: ${conn.status}`)
      for (const t of conn.body.tools as { name: string }[]) {
        const res = await api('PATCH', `/v1/connections/${id}/tools/${encodeURIComponent(t.name)}`, { confirm: 'proposed' })
        if (res.status >= 300) throw new Error(`confirming tool ${t.name} failed: ${res.status}`)
      }
    }
    for (const file of (await readdir(AGENT_DIR)).filter((f) => f.endsWith('.json')).sort()) {
      const agent = await api('POST', '/v1/agents', JSON.parse(await readFile(`${AGENT_DIR}/${file}`, 'utf8')))
      if (agent.status >= 300) throw new Error(`registering agent ${file} failed: ${agent.status}`)
    }

    const started = { shop, service }
    return {
      shop,
      api,
      async close() {
        await started.service.close()
        await started.shop.close()
        await pool.end()
      },
    }
  } catch (err) {
    await service?.close().catch(() => undefined)
    await shop?.close().catch(() => undefined)
    await migrator.end().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw err
  }
}
