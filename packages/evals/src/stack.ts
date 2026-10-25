import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { LLMPort } from '@agent-core/core'
import { createServiceStack } from '@agent-core/service'
import { assertTestDatabase, assertTestPool, createPool, runMigrations } from '@agent-core/store-postgres'
import { startShop } from '@agent-core/shop'

const ADMIN_KEY = 'eval-admin-key'
const AGENT_PATH = fileURLToPath(new URL('../agents/shop.json', import.meta.url))

export type EvalStack = {
  shop: Awaited<ReturnType<typeof startShop>>
  // JSON bodies are checked ad hoc by the runner, so `body` stays loosely typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>
  close(): Promise<void>
}

/** Resets the test database, then starts the shop and the service with connection `shop` and agent `shop`. */
export async function startEvalStack(opts: { llm: LLMPort }): Promise<EvalStack> {
  const databaseUrl =
    process.env.EVAL_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
  assertTestDatabase(databaseUrl) // the reset below drops every table
  const pool = createPool(databaseUrl)
  let shop: EvalStack['shop'] | undefined
  let service: ReturnType<typeof createServiceStack> | undefined
  try {
    await assertTestPool(pool)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await runMigrations(pool)
    shop = await startShop()
    service = createServiceStack({
      pool,
      adminKey: ADMIN_KEY,
      llm: opts.llm,
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
    const conn = await api('POST', '/v1/connections', { id: 'shop', url: shop.url })
    if (conn.status >= 300) throw new Error(`registering connection failed: ${conn.status}`)
    // Evals run the agent as a team would after confirming every proposed safety value.
    for (const t of conn.body.tools as { name: string }[]) {
      const res = await api('PATCH', `/v1/connections/shop/tools/${encodeURIComponent(t.name)}`, { confirm: 'proposed' })
      if (res.status >= 300) throw new Error(`confirming tool ${t.name} failed: ${res.status}`)
    }
    const agent = await api('POST', '/v1/agents', JSON.parse(await readFile(AGENT_PATH, 'utf8')))
    if (agent.status >= 300) throw new Error(`registering agent failed: ${agent.status}`)

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
    await pool.end().catch(() => undefined)
    throw err
  }
}
