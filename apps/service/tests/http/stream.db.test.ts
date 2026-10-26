import { hashAdminKey } from '../../src/bootstrap'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import type { NewEvent } from '@agent-core/core'
import { PgRunStore, assertTestDatabase, createPool, createRun, createTenant, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { buildApp } from '../../src/http/app'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
const ADMIN_KEY = 'test-admin-key'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>
let app: FastifyInstance
let base: string

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  app = buildApp({ secrets: box, pool, adminKeyHash: hashAdminKey(ADMIN_KEY) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

const created = (): NewEvent => ({ type: 'run.created', payload: { agentId: 'a', input: { text: 'hi' } }, labels: ['trusted'] })
const state = (from: 'queued' | 'running', to: 'running' | 'completed'): NewEvent => ({
  type: 'run.state_changed',
  payload: { from, to },
  labels: [],
})
const llm = (): NewEvent => ({ type: 'llm.requested', payload: { model: 'm' }, labels: [] })

async function seedRun(runId: string, tenantId = 'default'): Promise<PgRunStore> {
  await createRun(pool, { tenantId, runId, agentId: 'a', agentVersion: 1, input: { text: 'hi' } })
  return new PgRunStore(pool, tenantId)
}

function open(path: string, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(base + path, { headers: { authorization: `Bearer ${ADMIN_KEY}`, ...headers }, signal })
}

type Frame = { id: string; event: string; data: { seq: number } }
function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('id: '))
    .map((b) => {
      const [id, event, data] = b.split('\n')
      return { id: id!.slice(4), event: event!.slice(7), data: JSON.parse(data!.slice(6)) as { seq: number } }
    })
}

test('completed run: sends all events in the SSE format, then closes', async () => {
  const store = await seedRun('r1')
  await store.append('r1', [created(), state('queued', 'running'), llm(), state('running', 'completed')])
  const res = await open('/v1/runs/r1/stream')
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  const text = await res.text()
  const frames = parseFrames(text)
  expect(frames.map((f) => f.id)).toEqual(['1', '2', '3', '4'])
  expect(frames.map((f) => f.event)).toEqual(['run.created', 'run.state_changed', 'llm.requested', 'run.state_changed'])
  expect(frames[2]!.data.seq).toBe(3)
  expect(text.startsWith('id: 1\nevent: run.created\ndata: {')).toBe(true)
})

test('streams existing events then live ones and closes when the run ends', async () => {
  const store = await seedRun('r2')
  await store.append('r2', [created(), state('queued', 'running')])
  const res = await open('/v1/runs/r2/stream')
  const body = res.text()
  await new Promise((r) => setTimeout(r, 700))
  await store.append('r2', [llm()])
  await new Promise((r) => setTimeout(r, 700))
  await store.append('r2', [state('running', 'completed')])
  expect(parseFrames(await body).map((f) => f.id)).toEqual(['1', '2', '3', '4'])
})

test('resumes from Last-Event-ID and from ?after=', async () => {
  const store = await seedRun('r3')
  await store.append('r3', [created(), state('queued', 'running'), llm(), state('running', 'completed')])
  const viaHeader = parseFrames(await (await open('/v1/runs/r3/stream', { 'last-event-id': '2' })).text())
  expect(viaHeader.map((f) => f.id)).toEqual(['3', '4'])
  const viaQuery = parseFrames(await (await open('/v1/runs/r3/stream?after=3')).text())
  expect(viaQuery.map((f) => f.id)).toEqual(['4'])
  expect((await open('/v1/runs/r3/stream?after=x')).status).toBe(400)
})

test("an unknown run and another tenant's run are 404", async () => {
  expect((await open('/v1/runs/nope/stream')).status).toBe(404)
  const owner = await createTenant(pool, 'owner')
  const store = await seedRun('r-owner', 'owner')
  await store.append('r-owner', [created(), state('queued', 'running'), state('running', 'completed')])
  const own = await fetch(`${base}/v1/runs/r-owner/stream`, { headers: { authorization: `Bearer ${owner!.apiKey}` } })
  expect(own.status).toBe(200)
  await own.text()
  const stranger = await createTenant(pool, 'stranger')
  const denied = await fetch(`${base}/v1/runs/r-owner/stream`, { headers: { authorization: `Bearer ${stranger!.apiKey}` } })
  expect(denied.status).toBe(404)
})

test('app.close() finishes within 2 s with an open stream', async () => {
  const store = await seedRun('r4')
  await store.append('r4', [created(), state('queued', 'running')])
  const ctl = new AbortController()
  const res = await open('/v1/runs/r4/stream', {}, ctl.signal)
  const reader = res.body!.getReader()
  await reader.read() // the stream is open and delivering
  const started = Date.now()
  await app.close()
  expect(Date.now() - started).toBeLessThan(2000)
  ctl.abort()
})
