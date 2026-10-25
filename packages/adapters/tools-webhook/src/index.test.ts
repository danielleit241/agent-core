import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import type { ToolDescriptor } from '@agent-core/core'
import { verifyWebhook } from '@agent-core/webhooks'
import { WebhookToolError, createWebhookInvoker } from './index'
import { verifyPrincipalJwt } from './jwt'

const SECRET = 'whsec-very-secret'
const NOW_MS = 1761290000_000

type Seen = { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }
type Handler = (req: IncomingMessage, res: ServerResponse) => void

const servers: Server[] = []
const closeAll = () => Promise.all(servers.splice(0).map((s) => new Promise((r) => (s.closeAllConnections(), s.close(r)))))
afterEach(closeAll)

async function start(handler: Handler) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      handler(req, res)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function tool(over: Partial<ToolDescriptor> = {}, effect: 'read' | 'write' = 'read'): ToolDescriptor {
  return {
    name: 'orders.get',
    description: '',
    inputSchema: {},
    safety: { effect, idempotency: false, reachesOutside: false, outputLabel: 'internal' },
    connectionId: 'shop',
    ...over,
  }
}
const writeTool = (over: Partial<ToolDescriptor> = {}) => tool({ name: 'payments.refund', ...over }, 'write')
const ctx = { idempotencyKey: 'key-1', dryRun: false }

function invoker(url: string, o: Parameters<typeof createWebhookInvoker>[1] = {}) {
  return createWebhookInvoker(async () => ({ url, secret: SECRET }), { nowMs: () => NOW_MS, ...o })
}
async function failure(p: Promise<unknown>): Promise<WebhookToolError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(WebhookToolError)
  return err as WebhookToolError
}

test('posts to <url>/<encoded name> with a signed body and the contract headers', async () => {
  const { url, seen } = await start((_q, res) => json(res, 200, { output: 'ok' }))
  const inv = invoker(`${url}/hooks/`)
  const r = await inv.call(tool({ name: 'a b/c' }), { id: 7 }, { ...ctx, dryRun: true })
  expect(r).toEqual({ content: 'ok', isError: false })
  const s = seen[0]!
  expect(s.method).toBe('POST')
  expect(s.url).toBe('/hooks/a%20b%2Fc')
  // The key and the dry-run flag are in the signed body; the headers repeat them.
  expect(JSON.parse(s.body)).toEqual({ tool: 'a b/c', input: { id: 7 }, idempotencyKey: 'key-1', dryRun: true })
  expect(s.headers['content-type']).toBe('application/json')
  expect(s.headers['idempotency-key']).toBe('key-1')
  expect(s.headers['x-agentcore-dry-run']).toBe('true')
  expect(s.headers['x-agentcore-principal']).toBeUndefined()
  expect(verifyWebhook(s.body, s.headers['x-agentcore-signature'] as string, SECRET, NOW_MS / 1000)).toBe(true)
  expect(verifyWebhook(s.body, s.headers['x-agentcore-signature'] as string, 'other', NOW_MS / 1000)).toBe(false)
})

test('dry-run header is false on a normal call', async () => {
  const { url, seen } = await start((_q, res) => json(res, 200, { output: 'ok' }))
  await invoker(url).call(tool(), {}, ctx)
  expect(seen[0]!.headers['x-agentcore-dry-run']).toBe('false')
})

test('sends a principal JWT with sub, roles, aud = connection id and exp = iat + 300', async () => {
  const { url, seen } = await start((_q, res) => json(res, 200, { output: 'ok' }))
  await invoker(url).call(tool(), {}, { ...ctx, principal: { id: 'u1', roles: ['support'] } })
  const jwt = seen[0]!.headers['x-agentcore-principal'] as string
  expect(verifyPrincipalJwt(jwt, { secret: SECRET, audience: 'shop', nowSec: NOW_MS / 1000 })).toEqual({ sub: 'u1', roles: ['support'] })
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString())
  expect(claims.exp - claims.iat).toBe(300)
  expect(verifyPrincipalJwt(jwt, { secret: SECRET, audience: 'other', nowSec: NOW_MS / 1000 })).toBeNull()
})

test('a string output is returned as is, other output is JSON', async () => {
  const { url } = await start((req, res) => json(res, 200, { output: req.url?.endsWith('str') ? 'plain' : { n: 1 } }))
  const inv = invoker(url)
  expect(await inv.call(tool({ name: 'str' }), {}, ctx)).toEqual({ content: 'plain', isError: false })
  expect(await inv.call(tool({ name: 'obj' }), {}, ctx)).toEqual({ content: '{"n":1}', isError: false })
})

test('a 2xx body without output is an invalid response', async () => {
  const invalid = { content: 'Tool returned an invalid response.', isError: true }
  const bodies: unknown[] = [{ result: 1 }, 'text', null]
  let i = 0
  const { url } = await start((_q, res) => json(res, 200, bodies[i++]))
  const inv = invoker(url)
  for (let n = 0; n < bodies.length; n++) expect(await inv.call(writeTool(), {}, ctx)).toEqual(invalid)
  const raw = await start((_q, res) => res.end('not json'))
  expect(await invoker(raw.url).call(writeTool(), {}, ctx)).toEqual(invalid)
})

test('a 4xx gives an error result with the tool message, capped at 2000 chars', async () => {
  const { url } = await start((req, res) => {
    if (req.url?.endsWith('long')) return json(res, 422, { error: { message: 'x'.repeat(3000) } })
    if (req.url?.endsWith('msg')) return json(res, 400, { error: { message: 'bad id' } })
    res.writeHead(404).end('nope')
  })
  const inv = invoker(url)
  expect(await inv.call(writeTool({ name: 'msg' }), {}, ctx)).toEqual({ content: 'bad id', isError: true })
  expect((await inv.call(writeTool({ name: 'long' }), {}, ctx)).content).toHaveLength(2000)
  expect(await inv.call(writeTool({ name: 'none' }), {}, ctx)).toEqual({ content: 'Tool returned HTTP 404.', isError: true })
})

test.each([408, 429, 500, 503])('status %i is tool_call_failed with notSent false, and a write is sent once', async (status) => {
  const { url, seen } = await start((_q, res) => res.writeHead(status).end('boom'))
  const err = await failure(invoker(url).call(writeTool(), {}, ctx))
  expect(err).toMatchObject({ code: 'tool_call_failed', notSent: false, detail: `HTTP ${status}` })
  expect(err.message).toBe(`tool_call_failed: shop: HTTP ${status}`)
  expect(seen).toHaveLength(1)
})

test('a redirect is not followed', async () => {
  const target = await start((_q, res) => json(res, 200, { output: 'leaked' }))
  const { url } = await start((_q, res) => res.writeHead(302, { Location: `${target.url}/x` }).end())
  const err = await failure(invoker(url).call(writeTool(), {}, ctx))
  expect(err).toMatchObject({ code: 'tool_call_failed', notSent: false })
  expect(target.seen).toHaveLength(0)
})

test('a slow server times out as tool_call_failed', async () => {
  const { url } = await start(() => undefined)
  const err = await failure(invoker(url, { timeoutMs: 50 }).call(writeTool(), {}, ctx))
  expect(err).toMatchObject({ code: 'tool_call_failed', notSent: false, detail: 'timeout' })
  expect(err.message).toBe('tool_call_failed: shop: timeout')
})

test('a connection reset is tool_call_failed', async () => {
  const { url } = await start((req) => req.socket.destroy())
  expect(await failure(invoker(url).call(writeTool(), {}, ctx))).toMatchObject({
    code: 'tool_call_failed',
    notSent: false,
    detail: 'connection error',
  })
})

test('a response over 1 MiB is tool_call_failed', async () => {
  const { url } = await start((_q, res) => json(res, 200, { output: 'x'.repeat(1024 * 1024 + 10) }))
  const err = await failure(invoker(url).call(writeTool(), {}, ctx))
  expect(err).toMatchObject({ code: 'tool_call_failed', notSent: false, detail: 'response too large' })
  expect(err.message).toBe('tool_call_failed: shop: response too large')
})

test('connection refused is connection_unreachable with notSent true', async () => {
  const { url } = await start(() => undefined)
  await closeAll()
  const err = await failure(invoker(url).call(writeTool(), {}, ctx))
  expect(err).toMatchObject({ code: 'connection_unreachable', notSent: true })
})

test('a resolve failure is connection_unavailable with notSent true, and does not leak the cause', async () => {
  const inv = createWebhookInvoker(async () => {
    throw new Error('db down at postgres://u:pw@h/db')
  })
  const err = await failure(inv.call(tool(), {}, ctx))
  expect(err).toMatchObject({ code: 'connection_unavailable', notSent: true, message: 'connection_unavailable: shop' })
})

test('a dry run of a write without dry-run support is refused before any request', async () => {
  const { url, seen } = await start((_q, res) => json(res, 200, { output: 'ok' }))
  const inv = invoker(url)
  const err = await failure(inv.call(writeTool(), {}, { ...ctx, dryRun: true }))
  expect(err).toMatchObject({ code: 'dry_run_not_supported', notSent: true })
  expect(seen).toHaveLength(0)
  expect((await inv.call(writeTool({ supports: ['dry-run'] }), {}, { ...ctx, dryRun: true })).isError).toBe(false)
  expect((await inv.call(tool(), {}, { ...ctx, dryRun: true })).isError).toBe(false)
})

test('a read is retried once with the same key; a second failure is reported', async () => {
  let n = 0
  const { url, seen } = await start((_q, res) => (n++ === 0 ? res.writeHead(500).end() : json(res, 200, { output: 'ok' })))
  expect(await invoker(url).call(tool(), {}, ctx)).toEqual({ content: 'ok', isError: false })
  expect(seen.map((s) => s.headers['idempotency-key'])).toEqual(['key-1', 'key-1'])

  const always = await start((_q, res) => res.writeHead(500).end())
  await failure(invoker(always.url).call(tool(), {}, ctx))
  expect(always.seen).toHaveLength(2)
})

test('a write is never retried', async () => {
  const { url, seen } = await start((_q, res) => res.writeHead(500).end())
  await failure(invoker(url).call(writeTool(), {}, ctx))
  expect(seen).toHaveLength(1)
})

test('no error message contains the URL or the secret', async () => {
  const withCreds = (u: string) => `${u.replace('http://', 'http://user:pw@')}/path?token=abc`
  const five = await start((_q, res) => res.writeHead(500).end(`${SECRET} http://x`))
  const reset = await start((req) => req.socket.destroy())
  const slow = await start(() => undefined)
  const messages: string[] = []
  for (const [s, o] of [[five, {}], [reset, {}], [slow, { timeoutMs: 50 }]] as const) {
    messages.push((await failure(invoker(withCreds(s.url), o).call(writeTool(), {}, ctx))).message)
  }
  const gone = await start(() => undefined)
  const goneUrl = withCreds(gone.url)
  await closeAll()
  messages.push((await failure(invoker(goneUrl).call(writeTool(), {}, ctx))).message)
  expect(messages).toHaveLength(4)
  for (const m of messages) {
    for (const leak of ['127.0.0.1', 'pw', 'token=abc', SECRET]) expect(m).not.toContain(leak)
  }
})
