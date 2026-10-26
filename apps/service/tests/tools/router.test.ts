import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import type { ToolDescriptor } from '@agent-core/core'
import type { ConfigRepo, Connection } from '@agent-core/store-postgres'
import { createToolRouter, createToolRouters } from '../../src/tools/router'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function hook(): Promise<string> {
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"output":"ok"}'))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const tool: ToolDescriptor = {
  name: 'points.get',
  description: 'x',
  inputSchema: {},
  safety: { effect: 'read', idempotency: true, reachesOutside: false, outputLabel: 'internal' },
  connectionId: 'loyalty',
}
const ctx = { idempotencyKey: 'k', dryRun: false }

/** A ConfigRepo stand-in that counts reads; `conn` can be set later to model a connection created afterwards. */
function fakeConfig(conn: Connection | null) {
  const state = { conn, reads: 0 }
  const config = {
    async getConnection() {
      state.reads++
      return state.conn
    },
  } as unknown as ConfigRepo
  return { config, state }
}

test('the kind of a connection is looked up once; later calls read the connection only for the call itself', async () => {
  const url = await hook()
  const { config, state } = fakeConfig({ id: 'loyalty', kind: 'webhook', url, secret: 's', tools: [], limits: null })
  const router = createToolRouter(config)
  expect(await router.call(tool, {}, ctx)).toEqual({ content: 'ok', isError: false })
  expect(state.reads).toBe(2)
  await router.call(tool, {}, ctx)
  expect(state.reads).toBe(3)
  await router.close()
})

test('a missing connection is not remembered: it works once it exists', async () => {
  const { config, state } = fakeConfig(null)
  const router = createToolRouter(config)
  await expect(router.call(tool, {}, ctx)).rejects.toMatchObject({ code: 'connection_unavailable', notSent: true })
  state.conn = { id: 'loyalty', kind: 'webhook', url: await hook(), secret: 's', tools: [], limits: null }
  expect((await router.call(tool, {}, ctx)).content).toBe('ok')
  await router.close()
})

test('createToolRouters keeps one router per tenant and closes them all', async () => {
  const routers = createToolRouters({} as never, {} as never)
  const a = routers.forTenant('a')
  expect(routers.forTenant('a')).toBe(a)
  expect(routers.forTenant('b')).not.toBe(a)
  await routers.close()
})
