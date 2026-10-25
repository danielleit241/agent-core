import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { claim, assertTestDatabase, createPool, enqueue, heartbeat, release, requeueIfHolder, runMigrations } from '..'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let pool: pg.Pool

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

const rowCount = async (): Promise<number> => (await pool.query('SELECT 1 FROM queue')).rowCount ?? 0

test('never lets two workers claim the same run', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  const [a, b] = await Promise.all([claim(pool, 'w1'), claim(pool, 'w2')])
  expect([a, b].filter(Boolean)).toHaveLength(1)
})

test('a stale lock can be reclaimed', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  await claim(pool, 'w1')
  expect(await claim(pool, 'w2', 0)).toEqual({ runId: 'r1', tenantId: 'default' })
})

test('future availableAt is not claimed yet', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default', availableAt: new Date(Date.now() + 60000) })
  expect(await claim(pool, 'w1')).toBeNull()
})

test('a fresh lock is not reclaimed', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  await claim(pool, 'w1')
  expect(await claim(pool, 'w2')).toBeNull()
})

test('release deletes the row only for the lock holder', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  await claim(pool, 'w1')
  await release(pool, 'r1', 'w2')
  expect(await rowCount()).toBe(1)
  await release(pool, 'r1', 'w1')
  expect(await rowCount()).toBe(0)
})

test('re-enqueue while claimed clears the lock, so the old holder cannot delete the new job', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  expect(await claim(pool, 'w1')).not.toBeNull()
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  await release(pool, 'r1', 'w1')
  expect(await rowCount()).toBe(1)
  expect(await claim(pool, 'w2')).toEqual({ runId: 'r1', tenantId: 'default' })
})

test('heartbeat refreshes the lock so a slower timeout no longer reclaims it', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  await claim(pool, 'w1')
  await pool.query("UPDATE queue SET locked_at = now() - interval '10 seconds'")
  const stale = await pool.query("SELECT 1 FROM queue WHERE locked_at < now() - interval '5 seconds'")
  expect(stale.rowCount).toBe(1)
  expect(await heartbeat(pool, 'r1', 'w2')).toBe(false)
  expect(await heartbeat(pool, 'r1', 'w1')).toBe(true)
  expect(await claim(pool, 'w2', 5000)).toBeNull()
})

test('heartbeat returns false when the row is gone', async () => {
  expect(await heartbeat(pool, 'nope', 'w1')).toBe(false)
})

test('requeueIfHolder with availableAt sets the time only for the lock holder', async () => {
  await enqueue(pool, { runId: 'r1', tenantId: 'default' })
  await claim(pool, 'w1')
  const at = new Date(Date.now() + 60_000)
  await requeueIfHolder(pool, 'r1', 'w2', at)
  expect((await pool.query('SELECT locked_by FROM queue')).rows).toEqual([{ locked_by: 'w1' }])
  await requeueIfHolder(pool, 'r1', 'w1', at)
  const row = (await pool.query('SELECT locked_by, available_at FROM queue')).rows[0]
  expect(row.locked_by).toBeNull()
  expect(new Date(row.available_at).getTime()).toBe(at.getTime())
})
