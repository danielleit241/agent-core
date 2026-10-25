import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { proposeSafety, resolveSafety } from '@agent-core/core'
import type { ToolDescriptor } from '@agent-core/core'
import { startShop } from '@agent-core/shop'
import { ToolInvocationError, createMcpInvoker, discoverMcpTools } from './index'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()))
})
async function shopUnderTest(...args: Parameters<typeof startShop>) {
  const shop = await startShop(...args)
  closers.push(shop.close)
  return shop
}
/** The tool as it runs after an admin confirmed its proposal. */
const confirmedTool = (d: { tool: ToolDescriptor; source: Parameters<typeof resolveSafety>[0] }): ToolDescriptor => ({
  ...d.tool,
  safety: resolveSafety(d.source, proposeSafety(d.source)).safety,
})

/** A tiny stateless MCP server whose tools carry the given `_meta`. */
async function metaServer(tools: Record<string, Record<string, unknown> | undefined>): Promise<string> {
  const http = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const server = new McpServer({ name: 'meta', version: '0.0.0' })
      for (const [name, _meta] of Object.entries(tools)) {
        server.registerTool(name, { annotations: { readOnlyHint: true, openWorldHint: false }, ...(_meta && { _meta }) }, async () => ({
          content: [{ type: 'text', text: 'ok' }],
        }))
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      void server.connect(transport).then(() => transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      }),
  )
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
}

function invokerFor(url: string) {
  const inv = createMcpInvoker(async () => url)
  closers.push(() => inv.close())
  return inv
}

test('discovers shop tools: unconfirmed safety is strict, hints are kept as the source', async () => {
  const shop = await shopUnderTest()
  const tools = await discoverMcpTools('shop', shop.url)
  const byName = Object.fromEntries(tools.map((t) => [t.tool.name, t.tool.safety.effect]))
  expect(byName).toEqual({ 'orders.get': 'write', 'payments.refund': 'write', 'inventory.check': 'write', 'orders.change_size': 'write' })
  expect(tools[0]!.source).toEqual({ annotations: { readOnlyHint: true, openWorldHint: false } })
  expect(tools[0]!.tool.connectionId).toBe('shop')
  expect(tools[0]!.tool.description).toBe('Look up an order by id: status, amount, customer.')
  expect(tools[0]!.tool.supports).toBeUndefined()
})

test('discovery reads agent-core/safety and agent-core/supports from _meta as proposals', async () => {
  const url = await metaServer({
    good: { 'agent-core/safety': { idempotency: true }, 'agent-core/supports': ['idempotency-key', 'bogus', 'dry-run'] },
  })
  const [good] = await discoverMcpTools('meta', url)
  expect(good!.source).toEqual({
    annotations: { readOnlyHint: true, openWorldHint: false },
    declared: { idempotency: true },
    supports: ['idempotency-key', 'dry-run'],
  })
  expect(good!.tool.supports).toEqual(['idempotency-key', 'dry-run'])
  // Nothing is confirmed yet, so the running safety stays strict.
  expect(good!.tool.safety).toEqual({ effect: 'write', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' })
})

test('discovery ignores an invalid agent-core/safety and logs the connection id', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const url = await metaServer({
    unknownKey: { 'agent-core/safety': { effect: 'read', extra: 1 } },
    badValue: { 'agent-core/safety': { effect: 'maybe' } },
    badSupports: { 'agent-core/supports': 'idempotency-key' },
  })
  const found = await discoverMcpTools('meta', url)
  for (const f of found) {
    expect(f.source.declared).toBeUndefined()
    expect(f.source.supports).toBeUndefined()
    expect(f.tool.supports).toBeUndefined()
  }
  const logged = err.mock.calls.map((c) => String(c[0]))
  expect(logged).toHaveLength(2)
  for (const line of logged) {
    expect(line).toContain('meta')
    expect(line).not.toContain(url)
  }
  err.mockRestore()
})

test('invoker calls refund and the shop records it', async () => {
  const shop = await shopUnderTest()
  const [, refund] = await discoverMcpTools('shop', shop.url)
  const inv = invokerFor(shop.url)
  const res = await inv.call(refund!.tool, { order_id: '1042', amount: 1200000 }, { idempotencyKey: 'r:1', dryRun: false })
  expect(res.isError).toBe(false)
  expect(res.content).toBe('Refunded 1200000 for order 1042')
  expect(shop.state.refunds).toEqual([{ orderId: '1042', amount: 1200000 }])
})

test('returns isError for a tool error and records nothing', async () => {
  const shop = await shopUnderTest()
  const [get, refund] = await discoverMcpTools('shop', shop.url)
  const inv = invokerFor(shop.url)
  const ctx = { idempotencyKey: 'k', dryRun: false }
  const res = await inv.call(refund!.tool, { order_id: '9999', amount: 1 }, ctx)
  expect(res).toEqual({ content: 'Order not found: 9999', isError: true })
  expect(shop.state.refunds).toEqual([])
  const ok = await inv.call(get!.tool, { order_id: '1042' }, ctx)
  expect(ok.isError).toBe(false)
  expect(JSON.parse(ok.content)).toEqual({ status: 'delivered', amount: 1200000, customerId: 'cus_2291', sku: 'tee-basic', size: 'M' })
})

test('reconnects once when the cached connection is dead', async () => {
  const shop = await shopUnderTest()
  const [get] = await discoverMcpTools('shop', shop.url)
  let url = shop.url
  const inv = createMcpInvoker(async () => url)
  closers.push(() => inv.close())
  const ctx = { idempotencyKey: 'k', dryRun: false }
  expect((await inv.call(get!.tool, { order_id: '1042' }, ctx)).isError).toBe(false)
  await shop.close()
  const second = await startShop()
  closers.push(second.close)
  url = second.url
  expect((await inv.call(get!.tool, { order_id: '1050' }, ctx)).isError).toBe(false)
})

test('discover throws connection_unreachable for a closed port', async () => {
  const shop = await shopUnderTest()
  const url = shop.url
  await shop.close()
  await expect(discoverMcpTools('shop', url)).rejects.toThrow('connection_unreachable: shop')
})

const ctx = { idempotencyKey: 'k', dryRun: false }

test('write tool is never retried when the connection drops after execution', async () => {
  const shop = await shopUnderTest()
  const [, refund] = await discoverMcpTools('shop', shop.url)
  const inv = invokerFor(shop.url)
  shop.failNextResponseAfterExecute()
  const err = await inv.call(refund!.tool, { order_id: '1042', amount: 5 }, ctx).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ToolInvocationError)
  expect(err).toMatchObject({ code: 'tool_call_failed', notSent: false })
  expect(shop.state.refunds).toEqual([{ orderId: '1042', amount: 5 }])
})

test('a failing read is attempted once; the runner owns retries', async () => {
  const shop = await shopUnderTest()
  const [get] = await discoverMcpTools('shop', shop.url)
  const inv = invokerFor(shop.url)
  // The fake fails only one response, so a second attempt would succeed: the throw proves there was exactly one attempt.
  shop.failNextResponseAfterExecute()
  const err = await inv.call(confirmedTool(get!), { order_id: '1042' }, ctx).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ToolInvocationError)
  expect(err).toMatchObject({ code: 'tool_call_failed', notSent: false })
})

test('unreachable server gives connection_unreachable with notSent true, and no call is retried', async () => {
  const shop = await shopUnderTest()
  const [get, refund] = await discoverMcpTools('shop', shop.url)
  const url = shop.url
  await shop.close()
  const inv = invokerFor(url)
  for (const tool of [get!.tool, refund!.tool]) {
    const err = await inv.call(tool, { order_id: '1042', amount: 1 }, ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolInvocationError)
    expect(err).toMatchObject({ code: 'connection_unreachable', notSent: true })
    expect((err as Error).message).not.toContain(url)
  }
})

test('dryRun on a write tool throws without calling the server; on a read tool it calls normally', async () => {
  const shop = await shopUnderTest()
  const [get, refund] = await discoverMcpTools('shop', shop.url)
  const inv = invokerFor(shop.url)
  const dry = { idempotencyKey: 'k', dryRun: true }
  await expect(inv.call(refund!.tool, { order_id: '1042', amount: 1 }, dry)).rejects.toThrow('dry_run_not_supported: payments.refund')
  expect(shop.state.refunds).toEqual([])
  expect(shop.state.initializeCount).toBe(1) // discovery only
  expect((await inv.call(confirmedTool(get!), { order_id: '1042' }, dry)).isError).toBe(false)
})

test('concurrent calls on a fresh invoker share one client', async () => {
  const shop = await shopUnderTest()
  const [get] = await discoverMcpTools('shop', shop.url)
  const before = shop.state.initializeCount
  const inv = invokerFor(shop.url)
  await Promise.all([1, 2, 3].map(() => inv.call(get!.tool, { order_id: '1042' }, ctx)))
  expect(shop.state.initializeCount - before).toBe(1)
})

test('close() drops cached clients so a later call reconnects', async () => {
  const shop = await shopUnderTest()
  const [get] = await discoverMcpTools('shop', shop.url)
  const before = shop.state.initializeCount
  const inv = invokerFor(shop.url)
  await inv.call(get!.tool, { order_id: '1042' }, ctx)
  await inv.close()
  await inv.call(get!.tool, { order_id: '1042' }, ctx)
  expect(shop.state.initializeCount - before).toBe(2)
})

test('resolveUrl failure is a not-sent connection_unavailable error that hides the cause', async () => {
  const shop = await shopUnderTest()
  const [get, refund] = await discoverMcpTools('shop', shop.url)
  const inv = createMcpInvoker(async () => {
    throw new Error('vault down: secret-token')
  })
  closers.push(() => inv.close())
  for (const tool of [get!.tool, refund!.tool]) {
    const err = await inv.call(tool, { order_id: '1042', amount: 1 }, ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolInvocationError)
    expect(err).toMatchObject({ code: 'connection_unavailable', notSent: true })
    expect((err as Error).message).not.toContain('secret-token')
  }
})

test('a changed URL drops the cached client and the next call reaches the new instance', async () => {
  const first = await shopUnderTest()
  const second = await shopUnderTest()
  const [, refund] = await discoverMcpTools('shop', first.url)
  let url = first.url
  const inv = createMcpInvoker(async () => url)
  closers.push(() => inv.close())
  await inv.call(refund!.tool, { order_id: '1042', amount: 1 }, ctx)
  url = second.url
  await inv.call(refund!.tool, { order_id: '1042', amount: 2 }, ctx)
  expect(first.state.refunds).toEqual([{ orderId: '1042', amount: 1 }])
  expect(second.state.refunds).toEqual([{ orderId: '1042', amount: 2 }])
})

test('connection errors never contain the URL or its credentials', async () => {
  const url = 'http://user:pass@127.0.0.1:1/mcp?api_key=k'
  const discoverErr = (await discoverMcpTools('shop', url).catch((e: unknown) => e)) as Error
  const inv = invokerFor(url)
  const tool = { name: 'orders.get', connectionId: 'shop', description: '', inputSchema: {}, safety: { effect: 'read', reach: 'internal', idempotent: true, reversible: true } } as never
  const callErr = (await inv.call(tool, {}, ctx).catch((e: unknown) => e)) as Error
  for (const err of [discoverErr, callErr]) {
    for (const secret of ['pass', 'api_key', '127.0.0.1']) expect(err.message).not.toContain(secret)
  }
})

test('a connect failure logs a redacted cause server-side', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    await expect(discoverMcpTools('shop', 'http://user:pass@127.0.0.1:1/mcp?api_key=k')).rejects.toThrow(/^connection_unreachable: shop$/)
    expect(spy).toHaveBeenCalled()
    const logged = spy.mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('shop')
    expect(logged).toContain('127.0.0.1:1/mcp')
    for (const secret of ['pass', 'api_key', 'user']) expect(logged).not.toContain(secret)
  } finally {
    spy.mockRestore()
  }
})
