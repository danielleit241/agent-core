import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
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

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timed out')
}

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const INPUT_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const MESSAGE_TOKEN = `ghp_${'f6G7h8I9j0'.repeat(4)}`
const ANSWER_TOKEN = `ghp_${'k1L2m3N4o5'.repeat(4)}`

test('no secret reaches the event log or an LLM request: tool output, run input, human message and answer', async () => {
  const s = (stack = await startStack([
    { toolCalls: [{ name: 'vault.read', arguments: {} }] },
    { toolCalls: [{ name: 'agent_core.ask_human', arguments: { question: 'Which token?' } }] },
    { content: 'Done.' },
  ]))

  // The tool echoes the connection's own signing secret, which only the service knows, and an AWS key.
  let connectionSecret = ''
  toolServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: { note: `signing ${connectionSecret} and ${AWS_KEY}` } }))
    })
  })
  await new Promise<void>((resolve) => toolServer!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(toolServer.address() as AddressInfo).port}`

  const conn = await s.api('POST', '/v1/connections', {
    id: 'vault',
    kind: 'webhook',
    url,
    tools: [
      {
        name: 'vault.read',
        description: 'Read the vault note.',
        inputSchema: { type: 'object', properties: {} },
        safety: { effect: 'read', idempotency: true, reachesOutside: false, outputLabel: 'internal' },
      },
    ],
  })
  expect(conn.status).toBe(201)
  connectionSecret = conn.body.secret
  expect(connectionSecret.length).toBeGreaterThanOrEqual(8)
  await s.api('POST', '/v1/agents', {
    id: 'vault-bot',
    instructions: 'Read the vault.',
    connections: ['vault'],
    autonomy: 'supervised',
    allow: [{ tool: 'vault.read' }],
  })

  const run = await s.api('POST', '/v1/runs', { agent: 'vault-bot', input: { text: `My token is ${INPUT_TOKEN}, read the vault.` } })
  expect(run.status).toBe(202)
  const runId = run.body.run_id as string
  const status = async (): Promise<string> => (await s.api('GET', `/v1/runs/${runId}`)).body.status
  await waitFor(async () => (await status()) === 'waiting_human')

  expect((await s.api('POST', `/v1/runs/${runId}/input`, { action: 'message', text: `Also use ${MESSAGE_TOKEN}` })).status).toBe(202)
  expect((await s.api('POST', `/v1/runs/${runId}/input`, { action: 'answer', text: `Use ${ANSWER_TOKEN}` })).status).toBe(202)
  await waitFor(async () => (await status()) === 'completed')

  const eventsText = JSON.stringify((await s.api('GET', `/v1/runs/${runId}/events`)).body)
  const llmText = JSON.stringify(s.llmRequests)
  for (const secret of [connectionSecret, AWS_KEY, INPUT_TOKEN, MESSAGE_TOKEN, ANSWER_TOKEN]) {
    expect(eventsText).not.toContain(secret)
    expect(llmText).not.toContain(secret)
  }
  expect(llmText).toContain('[REDACTED:github_token]')

  const events = (await s.api('GET', `/v1/runs/${runId}/events`)).body.events as { type: string; payload: Record<string, any> }[] // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(events.find((e) => e.type === 'run.created')!.payload.input.redactions).toEqual({ github_token: 1 })
  expect(events.find((e) => e.type === 'input.received')!.payload.redactions).toEqual({ github_token: 1 })
  const responded = events.filter((e) => e.type === 'tool.responded')
  expect(responded[0]!.payload.redactions).toEqual({ aws_access_key: 1, known_secret: 1 })
  expect(responded[1]!.payload.redactions).toEqual({ github_token: 1 })
})

test('the configured LLM API key is removed from a tool output before the log and the LLM', async () => {
  const llmKey = 'llm-key-0123456789abcdef'
  const s = (stack = await startStack([{ toolCalls: [{ name: 'vault.read', arguments: {} }] }, { content: 'Done.' }], { llmApiKey: llmKey }))
  toolServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: { note: `key is ${llmKey}` } }))
    })
  })
  await new Promise<void>((resolve) => toolServer!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(toolServer.address() as AddressInfo).port}`
  await s.api('POST', '/v1/connections', {
    id: 'vault',
    kind: 'webhook',
    url,
    tools: [
      {
        name: 'vault.read',
        description: 'Read the vault note.',
        inputSchema: { type: 'object', properties: {} },
        safety: { effect: 'read', idempotency: true, reachesOutside: false, outputLabel: 'internal' },
      },
    ],
  })
  await s.api('POST', '/v1/agents', { id: 'vault-bot', instructions: 'Read the vault.', connections: ['vault'], autonomy: 'supervised', allow: [{ tool: 'vault.read' }] })
  const run = await s.api('POST', '/v1/runs?wait=10', { agent: 'vault-bot', input: { text: 'read it' } })
  await waitFor(async () => (await s.api('GET', `/v1/runs/${run.body.id}`)).body.status === 'completed')
  const eventsText = JSON.stringify((await s.api('GET', `/v1/runs/${run.body.id}/events`)).body)
  expect(eventsText).not.toContain(llmKey)
  expect(JSON.stringify(s.llmRequests)).not.toContain(llmKey)
  expect(eventsText).toContain('[REDACTED:known_secret]')
})
