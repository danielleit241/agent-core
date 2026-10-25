import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { verifyChain } from '@agent-core/core'
import type { NewEvent, RunStatus } from '@agent-core/core'
import {
  ChainIntegrityError,
  LockLostError,
  PgRunStore,
  StateConflictError,
  assertTestDatabase,
  assertTestPool,
  createPool,
  createRun,
  claim,
  createRunWithEvent,
  enqueue,
  getRun,
  getRunHead,
  requeueIfHolder,
  runMigrations,
} from './index'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let pool: pg.Pool

const ev = {
  runCreated: (): NewEvent => ({
    type: 'run.created',
    payload: { agentId: 'a', input: { text: 'hi' } },
    labels: ['trusted'],
  }),
  llmRequested: (): NewEvent => ({ type: 'llm.requested', payload: { model: 'm' }, labels: ['trusted'] }),
  stateChanged: (from: RunStatus, to: RunStatus, reason?: string): NewEvent => ({
    type: 'run.state_changed',
    payload: { from, to, reason },
    labels: ['trusted'],
  }),
}

beforeAll(() => {
  assertTestDatabase(url)
  pool = createPool(url)
})
beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
})
afterAll(async () => {
  await pool.end()
})

test('append assigns consecutive seq and a valid chain', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r1', agentId: 'a', agentVersion: 1, input: { text: 'hi' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('r1', [ev.runCreated(), ev.llmRequested()])
  await store.append('r1', [ev.stateChanged('queued', 'running')])
  const events = await store.readEvents('r1')
  expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  expect(verifyChain(events)).toEqual({ valid: true })
  expect((await getRun(pool, 'default', 'r1'))?.status).toBe('running')
})

test('concurrent appends to one run never duplicate seq', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r2', agentId: 'a', agentVersion: 1, input: { text: 'hi' } })
  const store = new PgRunStore(pool, 'default')
  await Promise.all(Array.from({ length: 10 }, () => store.append('r2', [ev.llmRequested()])))
  const events = await store.readEvents('r2')
  expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(verifyChain(events)).toEqual({ valid: true })
})

test('createRun with a repeated idempotency key returns the first run', async () => {
  const a = await createRun(pool, { tenantId: 'default', runId: 'r3', agentId: 'a', agentVersion: 1, input: { text: 'x' }, idempotencyKey: 'k1' })
  const b = await createRun(pool, { tenantId: 'default', runId: 'r4', agentId: 'a', agentVersion: 1, input: { text: 'x' }, idempotencyKey: 'k1' })
  expect(b).toEqual({ runId: 'r3', created: false })
  expect(a.created).toBe(true)
})

test('waiting_human stores the reason and a later change clears it', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r5', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('r5', [ev.stateChanged('queued', 'waiting_human', 'approval')])
  expect(await getRun(pool, 'default', 'r5')).toMatchObject({ status: 'waiting_human', waitingReason: 'approval' })
  await store.append('r5', [ev.stateChanged('waiting_human', 'running')])
  expect(await getRun(pool, 'default', 'r5')).toMatchObject({ status: 'running', waitingReason: null })
})

test('append rejects invalid events and unknown runs', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r6', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  const bad = { type: 'llm.requested', payload: {}, labels: [] } as unknown as NewEvent
  await expect(store.append('r6', [bad])).rejects.toThrow()
  expect(await store.readEvents('r6')).toEqual([])
  await expect(store.append('missing', [ev.llmRequested()])).rejects.toThrow(/not found/)
})

test('readEvents is filtered by tenant', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r7', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('r7', [ev.llmRequested()])
  expect((await store.readEvents('r7'))[0]?.tenantId).toBe('default')
  expect(await new PgRunStore(pool, 'other').readEvents('r7')).toEqual([])
})

test('runMigrations is a no-op the second time', async () => {
  const before = await pool.query('SELECT name FROM schema_migrations ORDER BY name')
  expect(before.rows.length).toBeGreaterThan(0)
  await runMigrations(pool)
  const after = await pool.query('SELECT name FROM schema_migrations ORDER BY name')
  expect(after.rows).toEqual(before.rows)
})

test('append with expect throws StateConflictError and writes nothing when the status differs', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r9', agentId: 'a', agentVersion: 1, input: { text: 'hi' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('r9', [ev.runCreated(), ev.stateChanged('queued', 'waiting_human', 'approval')])
  const before = (await store.readEvents('r9')).length
  await expect(
    store.append('r9', [ev.stateChanged('waiting_human', 'running')], { expect: { status: 'running' } }),
  ).rejects.toBeInstanceOf(StateConflictError)
  await expect(
    store.append('r9', [ev.stateChanged('waiting_human', 'running')], {
      expect: { status: 'waiting_human', waitingReason: 'breaker' },
    }),
  ).rejects.toBeInstanceOf(StateConflictError)
  expect((await store.readEvents('r9')).length).toBe(before)
  await store.append('r9', [ev.stateChanged('waiting_human', 'running')], {
    expect: { status: 'waiting_human', waitingReason: 'approval' },
  })
  expect((await getRun(pool, 'default', 'r9'))?.status).toBe('running')
})

test('a state change from a status the run is no longer in throws StateConflictError and writes nothing', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r19', agentId: 'a', agentVersion: 1, input: { text: 'hi' } })
  const store = new PgRunStore(pool, 'default')
  // A worker read "queued", then the run was cancelled before the worker wrote its transition.
  await store.append('r19', [ev.runCreated(), ev.stateChanged('queued', 'cancelled')])
  const before = (await store.readEvents('r19')).length
  await expect(store.append('r19', [ev.stateChanged('queued', 'running')])).rejects.toBeInstanceOf(StateConflictError)
  await expect(
    store.append('r19', [ev.llmRequested(), ev.stateChanged('cancelled', 'running'), ev.stateChanged('queued', 'failed')]),
  ).rejects.toBeInstanceOf(StateConflictError)
  expect((await store.readEvents('r19')).length).toBe(before)
  expect((await getRun(pool, 'default', 'r19'))?.status).toBe('cancelled')
})

test('updating or deleting an event is rejected by the database', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r10', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  await new PgRunStore(pool, 'default').append('r10', [ev.llmRequested()])
  await expect(pool.query("UPDATE events SET type = 'x' WHERE run_id = 'r10'")).rejects.toThrow(/append-only/)
  await expect(pool.query("DELETE FROM events WHERE run_id = 'r10'")).rejects.toThrow(/append-only/)
})

test('append keeps the log head on the run row', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r11', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  expect(await getRunHead(pool, 'default', 'r11')).toEqual({ lastSeq: null, lastHash: null })
  const stored = await store.append('r11', [ev.runCreated(), ev.llmRequested()])
  expect(await getRunHead(pool, 'default', 'r11')).toEqual({ lastSeq: 2, lastHash: stored[1]!.hash })
  expect(await getRunHead(pool, 'default', 'ghost')).toBeNull()
})

test('NUL and lone surrogates in a payload are replaced before hashing', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r12', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('r12', [
    {
      type: 'tool.responded',
      payload: { toolCallId: 'c1', content: 'a\u0000b\ud800c\udc00d 😀', isError: false },
      labels: ['untrusted'],
    },
  ])
  const events = await store.readEvents('r12')
  expect(events[0]!.payload).toMatchObject({ content: 'a�b�c�d 😀' })
  expect(verifyChain(events)).toEqual({ valid: true })
})

const newRun = (runId: string, idempotencyKey?: string) => ({
  tenantId: 'default',
  runId,
  agentId: 'a',
  agentVersion: 1,
  ...(idempotencyKey ? { idempotencyKey } : {}),
  created: ev.runCreated(),
})
const queueRows = async (runId: string): Promise<number> =>
  (await pool.query('SELECT 1 FROM queue WHERE run_id = $1', [runId])).rowCount ?? 0

test('createRunWithEvent inserts the run, run.created and the queue row together', async () => {
  const res = await createRunWithEvent(pool, newRun('r13', 'k13'))
  expect(res).toEqual({ id: 'r13', created: true })
  const events = await new PgRunStore(pool, 'default').readEvents('r13')
  expect(events.map((e) => e.type)).toEqual(['run.created'])
  expect(verifyChain(events)).toEqual({ valid: true })
  expect(await queueRows('r13')).toBe(1)
  expect((await getRunHead(pool, 'default', 'r13'))?.lastSeq).toBe(1)
})

test('createRunWithEvent on a replayed key appends and enqueues nothing', async () => {
  await createRunWithEvent(pool, newRun('r14', 'k14'))
  await pool.query('DELETE FROM queue')
  const again = await createRunWithEvent(pool, newRun('r15', 'k14'))
  expect(again).toEqual({ id: 'r14', created: false })
  expect(await new PgRunStore(pool, 'default').readEvents('r14')).toHaveLength(1)
  expect(await queueRows('r14')).toBe(0)
  expect((await pool.query("SELECT 1 FROM runs WHERE id = 'r15'")).rowCount).toBe(0)
})

test('createRunWithEvent leaves nothing behind when the event is invalid', async () => {
  const bad = { ...newRun('r16', 'k16'), created: { type: 'run.created', payload: {}, labels: [] } as unknown as NewEvent }
  await expect(createRunWithEvent(pool, bad)).rejects.toThrow()
  expect((await pool.query('SELECT 1 FROM runs')).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM events')).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM queue')).rowCount).toBe(0)
})

test('append with enqueue puts the queue row in the same transaction', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'r17', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('r17', [ev.stateChanged('queued', 'waiting_human', 'approval')])
  await expect(
    store.append('r17', [ev.stateChanged('waiting_human', 'running')], { expect: { status: 'running' }, enqueue: true }),
  ).rejects.toBeInstanceOf(StateConflictError)
  expect(await queueRows('r17')).toBe(0)
  await store.append('r17', [ev.stateChanged('waiting_human', 'running')], { expect: { status: 'waiting_human' }, enqueue: true })
  expect(await queueRows('r17')).toBe(1)
})

test('assertTestPool checks the database the pool is connected to', async () => {
  await expect(assertTestPool(pool)).resolves.toBeUndefined()
  const other = createPool(url.replace(/agentcore_test(\?|$)/, 'postgres$1'))
  try {
    await expect(assertTestPool(other)).rejects.toThrow(/_test/)
  } finally {
    await other.end()
  }
})

test('assertTestDatabase accepts *_test databases only', () => {
  expect(() => assertTestDatabase('postgres://u:p@localhost:5433/agentcore_test')).not.toThrow()
  expect(() => assertTestDatabase('postgres://u:p@localhost:5433/agentcore')).toThrow(/_test/)
})

test('concurrent migrators on an empty database do not fail', async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await Promise.all(Array.from({ length: 6 }, () => runMigrations(pool)))
  expect((await pool.query('SELECT name FROM schema_migrations')).rowCount).toBeGreaterThanOrEqual(2)
})

test('append refuses a run whose tail events were deleted, and writes nothing', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'c4', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('c4', [ev.runCreated(), ev.llmRequested(), ev.llmRequested()])
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await pool.query('DELETE FROM events WHERE run_id = $1 AND seq = 3', ['c4'])
  await expect(store.append('c4', [ev.llmRequested()])).rejects.toBeInstanceOf(ChainIntegrityError)
  expect((await store.readEvents('c4')).map((e) => e.seq)).toEqual([1, 2])
  expect(await getRunHead(pool, 'default', 'c4')).toMatchObject({ lastSeq: 3 })
})

test('append refuses a run whose events were all deleted', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'c4b', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  const store = new PgRunStore(pool, 'default')
  await store.append('c4b', [ev.runCreated()])
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await pool.query('DELETE FROM events WHERE run_id = $1', ['c4b'])
  await expect(store.append('c4b', [ev.llmRequested()])).rejects.toBeInstanceOf(ChainIntegrityError)
})

test('a fenced store appends only while it holds the queue lock', async () => {
  await createRun(pool, { tenantId: 'default', runId: 'c5', agentId: 'a', agentVersion: 1, input: { text: 'x' } })
  await enqueue(pool, { runId: 'c5', tenantId: 'default' })
  await claim(pool, 'w1')
  const w1 = new PgRunStore(pool, 'default', { lockedBy: 'w1' })
  await w1.append('c5', [ev.runCreated()])
  await pool.query("UPDATE queue SET locked_by = 'w2' WHERE run_id = 'c5'")
  await expect(w1.append('c5', [ev.llmRequested()])).rejects.toBeInstanceOf(LockLostError)
  expect((await w1.readEvents('c5')).map((e) => e.seq)).toEqual([1])
  await pool.query("DELETE FROM queue WHERE run_id = 'c5'")
  await expect(w1.append('c5', [ev.llmRequested()])).rejects.toBeInstanceOf(LockLostError)
  await new PgRunStore(pool, 'default').append('c5', [ev.llmRequested()]) // the unfenced store is not affected
})

test('requeueIfHolder unlocks the job only for the lock holder', async () => {
  await enqueue(pool, { runId: 'q1', tenantId: 'default' })
  await claim(pool, 'w1')
  await requeueIfHolder(pool, 'q1', 'w2')
  expect((await pool.query('SELECT locked_by FROM queue')).rows).toEqual([{ locked_by: 'w1' }])
  await requeueIfHolder(pool, 'q1', 'w1')
  expect((await pool.query('SELECT locked_by FROM queue')).rows).toEqual([{ locked_by: null }])
})
