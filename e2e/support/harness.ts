import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSecretBox } from '@agent-core/core'
import { createServiceStack } from '@agent-core/service'
import { createOpenAICompatible } from '@agent-core/llm'
import { assertTestDatabase, assertTestPool, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { startFakeLlm } from '@agent-core/fake-llm'
import type { FakeTurn } from '@agent-core/fake-llm'
import { startShop } from '@agent-core/shop'

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
export const ADMIN_KEY = 'e2e-admin-key'

export type Received = { headers: Record<string, string | string[] | undefined>; body: string }

export type Stack = {
  // JSON bodies are asserted ad hoc by tests, so `body` stays loosely typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: any }>
  /** Like `api`, but with the given API key instead of the admin key. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiAs(key: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>
  shop: Awaited<ReturnType<typeof startShop>>
  receiver: { url: string; received: Received[] }
  close(): Promise<void>
}

export type StackOpts = {
  /** Status for each successive webhook request; 200 after the list ends. */
  receiverStatuses?: number[]
  /** Use a real OpenAI-compatible endpoint instead of the fake LLM (live smoke only). */
  realLlm?: { baseUrl: string; apiKey: string; model: string }
}

export async function startStack(script: FakeTurn[], opts: StackOpts = {}): Promise<Stack> {
  assertTestDatabase(DATABASE_URL) // the reset below drops every table
  const migrator = createPool(DATABASE_URL)
  await assertTestPool(migrator)
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  await migrator.end()
  const pool = createPool(runtimeTestUrl(DATABASE_URL))

  const shop = await startShop()
  const fakeLlm = opts.realLlm ? undefined : await startFakeLlm(script)

  const received: Received[] = []
  const statuses = [...(opts.receiverStatuses ?? [])]
  const receiverServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(statuses.shift() ?? 200).end()
    })
  })
  await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve))
  const receiverUrl = `http://127.0.0.1:${(receiverServer.address() as AddressInfo).port}/hook`

  const llm = opts.realLlm
    ? createOpenAICompatible({ baseUrl: opts.realLlm.baseUrl, apiKey: opts.realLlm.apiKey, models: { default: opts.realLlm.model } })
    : createOpenAICompatible({ baseUrl: fakeLlm!.url, apiKey: 'fake', models: { default: 'fake-model' } })
  const stack = createServiceStack({
    pool,
    adminKey: ADMIN_KEY,
    secrets: createSecretBox(Buffer.alloc(32, 7)),
    llm,
    workerId: 'e2e-worker',
    runPollMs: 20,
    deliveryPollMs: 20,
    deliveryDelaysS: [0, 0],
  })
  await stack.app.listen({ port: 0, host: '127.0.0.1' })
  const baseUrl = `http://127.0.0.1:${(stack.app.server.address() as AddressInfo).port}`

  async function request(key: string, method: string, path: string, body?: unknown, timeoutMs?: number) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? undefined : JSON.parse(text) }
  }

  return {
    api: (method, path, body, timeoutMs) => request(ADMIN_KEY, method, path, body, timeoutMs),
    apiAs: (key, method, path, body) => request(key, method, path, body),
    shop,
    receiver: { url: receiverUrl, received },
    async close() {
      await stack.close()
      await shop.close()
      await fakeLlm?.close()
      receiverServer.closeAllConnections()
      await new Promise<void>((resolve) => receiverServer.close(() => resolve()))
      await pool.end()
    },
  }
}
