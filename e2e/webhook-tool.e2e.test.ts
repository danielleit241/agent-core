import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import { verifyPrincipalJwt } from '@agent-core/tools-webhook'
import { verifyWebhook } from '@agent-core/webhooks'
import { startStack } from './support/harness'
import type { Stack } from './support/harness'

let stack: Stack | undefined
let toolServer: ReturnType<typeof createServer> | undefined
afterEach(async () => {
  await stack?.close()
  stack = undefined
  toolServer?.closeAllConnections()
  await new Promise<void>((resolve) => (toolServer ? toolServer.close(() => resolve()) : resolve()))
  toolServer = undefined
})

const nowSec = (): number => Math.floor(Date.now() / 1000)

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timed out')
}

test('a webhook tool runs with a signed request, principal JWT and idempotency key', async () => {
  const s = (stack = await startStack([
    { toolCalls: [{ name: 'loyalty.points_add', arguments: { points: 50 } }] },
    { content: 'Đã cộng 50 điểm.' },
  ]))

  let secret = ''
  const seen: { path: string; body: string; sigOk: boolean; jwtSub?: string; key?: string; dryRun?: string }[] = []
  toolServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const jwt = verifyPrincipalJwt(String(req.headers['x-agentcore-principal'] ?? ''), { secret, audience: 'loyalty', nowSec: nowSec() })
      seen.push({
        path: req.url ?? '',
        body,
        sigOk: verifyWebhook(body, String(req.headers['x-agentcore-signature'] ?? ''), secret, nowSec()),
        jwtSub: jwt?.sub,
        key: req.headers['idempotency-key'] as string | undefined,
        dryRun: req.headers['x-agentcore-dry-run'] as string | undefined,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: { balance: 150 } }))
    })
  })
  await new Promise<void>((resolve) => toolServer!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(toolServer.address() as AddressInfo).port}`

  const conn = await s.api('POST', '/v1/connections', {
    id: 'loyalty',
    kind: 'webhook',
    url,
    tools: [
      {
        name: 'loyalty.points_add',
        description: 'Add loyalty points to the customer.',
        inputSchema: { type: 'object', properties: { points: { type: 'number' } }, required: ['points'] },
        safety: { effect: 'write', idempotency: true, reachesOutside: false, outputLabel: 'internal' },
        supports: ['principal', 'idempotency-key'],
      },
    ],
  })
  expect(conn.status).toBe(201)
  secret = conn.body.secret
  await s.api('POST', '/v1/agents', {
    id: 'loyalty-bot',
    instructions: 'Add loyalty points.',
    connections: ['loyalty'],
    autonomy: 'supervised',
    allow: [{ tool: 'loyalty.points_add' }],
  })

  const run = await s.api('POST', '/v1/runs?wait=10', {
    agent: 'loyalty-bot',
    input: { text: 'Cộng 50 điểm' },
    principal: { id: 'cus_2291', roles: ['customer'] },
  })
  await waitFor(async () => (await s.api('GET', `/v1/runs/${run.body.id}`)).body.status === 'completed')

  const events = (await s.api('GET', `/v1/runs/${run.body.id}/events`)).body.events as { type: string; payload: Record<string, unknown> }[]
  const requested = events.find((e) => e.type === 'tool.requested')!
  const responded = events.find((e) => e.type === 'tool.responded')!
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    path: '/loyalty.points_add',
    sigOk: true,
    jwtSub: 'cus_2291',
    key: requested.payload.idempotencyKey,
    dryRun: 'false',
  })
  expect(JSON.parse(seen[0]!.body)).toEqual({
    tool: 'loyalty.points_add',
    input: { points: 50 },
    idempotencyKey: requested.payload.idempotencyKey,
    dryRun: false,
  })
  expect(JSON.stringify(responded.payload)).toContain('150')
  expect((await s.api('GET', `/v1/runs/${run.body.id}`)).body.output).toBe('Đã cộng 50 điểm.')
})
