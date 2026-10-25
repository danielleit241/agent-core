import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { claim, assertTestDatabase, createPool, enqueue, heartbeat, release, requeueIfHolder, runMigrations } from '../../src'

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
  expect(await claim(pool, 'w2', { lockTimeoutMs: 0 })).toEqual({ runId: 'r1', tenantId: 'default' })
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
  expect(await claim(pool, 'w2', { lockTimeoutMs: 5000 })).toBeNull()
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

const lockedCount = async (tenant: string): Promise<number> =>
  (await pool.query('SELECT 1 FROM queue WHERE tenant_id = $1 AND locked_by IS NOT NULL', [tenant])).rowCount ?? 0

test('a busy tenant does not block another tenant', async () => {
  for (let i = 0; i < 10; i++) await enqueue(pool, { runId: `a${i}`, tenantId: 'A', availableAt: new Date(Date.now() - 10000 + i) })
  await enqueue(pool, { runId: 'b1', tenantId: 'B' })
  expect(await claim(pool, 'w1')).toEqual({ runId: 'a0', tenantId: 'A' })
  expect(await claim(pool, 'w2')).toEqual({ runId: 'b1', tenantId: 'B' })
})

test('maxPerTenant caps running jobs and frees a slot on release', async () => {
  for (let i = 0; i < 4; i++) await enqueue(pool, { runId: `a${i}`, tenantId: 'A' })
  const first = await claim(pool, 'w1', { maxPerTenant: 2 })
  expect(await claim(pool, 'w2', { maxPerTenant: 2 })).not.toBeNull()
  expect(await claim(pool, 'w3', { maxPerTenant: 2 })).toBeNull()
  await release(pool, first!.runId, 'w1')
  expect(await claim(pool, 'w3', { maxPerTenant: 2 })).toMatchObject({ tenantId: 'A' })
})

test('concurrent claims never exceed maxPerTenant', async () => {
  for (let i = 0; i < 5; i++) {
    await enqueue(pool, { runId: `a${i}`, tenantId: 'A' })
    await enqueue(pool, { runId: `b${i}`, tenantId: 'B' })
  }
  await Promise.all(Array.from({ length: 8 }, (_, i) => claim(pool, `w${i}`, { maxPerTenant: 2 })))
  expect(await lockedCount('A')).toBeLessThanOrEqual(2)
  expect(await lockedCount('B')).toBeLessThanOrEqual(2)
  expect(await lockedCount('A')).toBe(2)
  expect(await lockedCount('B')).toBe(2)
})

test('a job with an expired lock does not count as running', async () => {
  for (let i = 0; i < 3; i++) await enqueue(pool, { runId: `a${i}`, tenantId: 'A' })
  await claim(pool, 'w1', { maxPerTenant: 1 })
  expect(await claim(pool, 'w2', { maxPerTenant: 1 })).toBeNull()
  await pool.query("UPDATE queue SET locked_at = now() - interval '10 minutes' WHERE locked_by = 'w1'")
  expect(await claim(pool, 'w2', { maxPerTenant: 1 })).not.toBeNull()
})
