import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { ConnectionLimits, GuardDenial } from '@agent-core/core'
import { assertTestDatabase, createPool, createTenant, PgConnectionGuard, runMigrations, runtimeTestUrl } from '../../src'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: pg.Pool
let pool: pg.Pool

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

const C = 'crm'
const guardFor = (limits: Partial<ConnectionLimits> | undefined, tenant = 'default'): PgConnectionGuard =>
  new PgConnectionGuard(pool, tenant, limits === undefined ? {} : { [C]: limits })
const isLease = (r: { lease: string } | { denied: GuardDenial }): r is { lease: string } => 'lease' in r
const denied = (r: { lease: string } | { denied: GuardDenial }): GuardDenial => {
  if (isLease(r)) throw new Error('expected a denial')
  return r.denied
}
const leaseCount = async (tenant = 'default'): Promise<number> =>
  (await migrator.query('SELECT 1 FROM connection_leases WHERE tenant_id = $1', [tenant])).rowCount ?? 0
const guardRow = async (tenant = 'default') =>
  (await migrator.query('SELECT * FROM connection_guards WHERE tenant_id = $1 AND connection_id = $2', [tenant, C])).rows[0]

async function openBreaker(g: PgConnectionGuard): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const r = await g.acquire(C)
    if (!isLease(r)) throw new Error('unexpected denial')
    await g.release(r.lease, 'failed')
  }
}

test('50 parallel acquires with concurrency 4 grant exactly 4 and deny the rest', async () => {
  const g = guardFor({ concurrency: 4, calls_per_minute: 1000 })
  const results = await Promise.all(Array.from({ length: 50 }, () => g.acquire(C)))
  expect(results.filter(isLease)).toHaveLength(4)
  const rest = results.filter((r) => !isLease(r)).map(denied)
  expect(rest).toHaveLength(46)
  expect(rest.every((d) => d.reason === 'concurrency' && d.retryAt === null)).toBe(true)
  expect(await leaseCount()).toBe(4)
})

test('50 workers looping acquire and release never hold more than 4 leases at once', async () => {
  const g = guardFor({ concurrency: 4, calls_per_minute: 1000 })
  let live = 0
  let max = 0
  const worker = async (): Promise<void> => {
    let done = 0
    while (done < 2) {
      const r = await g.acquire(C)
      if (!isLease(r)) {
        await new Promise((res) => setTimeout(res, 2))
        continue
      }
      live++
      max = Math.max(max, live)
      await new Promise((res) => setTimeout(res, 5))
      live--
      await g.release(r.lease, 'ok')
      done++
    }
  }
  await Promise.all(Array.from({ length: 50 }, worker))
  expect(max).toBeGreaterThan(0)
  expect(max).toBeLessThanOrEqual(4)
  expect(await leaseCount()).toBe(0)
})

test('the rate limit denies the call after the quota until the window moves on', async () => {
  const g = guardFor({ calls_per_minute: 3, concurrency: 10 })
  for (let i = 0; i < 3; i++) expect(isLease(await g.acquire(C))).toBe(true)
  const d = denied(await g.acquire(C))
  expect(d.reason).toBe('rate')
  const row = await guardRow()
  expect(d.retryAt).toBe(new Date(row.window_start.getTime() + 60_000).toISOString())
  await migrator.query("UPDATE connection_guards SET window_start = window_start - interval '1 minute'")
  expect(isLease(await g.acquire(C))).toBe(true)
  expect((await guardRow()).window_calls).toBe(1)
})

test('5 failed calls open the breaker and calls are denied without a lease', async () => {
  const g = guardFor({ concurrency: 10, calls_per_minute: 1000 })
  await openBreaker(g)
  const row = await guardRow()
  expect(row.opened_at).not.toBeNull()
  const d = denied(await g.acquire(C))
  expect(d).toEqual({ reason: 'breaker', retryAt: new Date(row.opened_at.getTime() + 30_000).toISOString() })
  expect(await leaseCount()).toBe(0)
})

test('after the open time exactly one trial call passes and an ok result closes the breaker', async () => {
  const g = guardFor({ concurrency: 10, calls_per_minute: 1000 })
  await openBreaker(g)
  await migrator.query("UPDATE connection_guards SET opened_at = opened_at - interval '31 seconds'")
  const [a, b] = await Promise.all([g.acquire(C), g.acquire(C)])
  expect([a, b].filter(isLease)).toHaveLength(1)
  expect(denied(isLease(a) ? b : a).reason).toBe('breaker')
  await g.release((isLease(a) ? a : (b as { lease: string })).lease, 'ok')
  const row = await guardRow()
  expect(row.opened_at).toBeNull()
  expect(row.failures).toBe(0)
  expect(row.trial_lease).toBeNull()
  expect(isLease(await g.acquire(C))).toBe(true)
})

test('an unused trial lease frees the half-open slot and leaves the breaker and failures as they were', async () => {
  const g = guardFor({ concurrency: 10, calls_per_minute: 1000 })
  await openBreaker(g)
  await migrator.query("UPDATE connection_guards SET opened_at = opened_at - interval '31 seconds'")
  const before = await guardRow()
  const trial = await g.acquire(C)
  if (!isLease(trial)) throw new Error('expected the trial')
  await g.release(trial.lease, 'unused')
  const row = await guardRow()
  expect(row.trial_lease).toBeNull()
  expect(row.opened_at).toEqual(before.opened_at)
  expect(row.failures).toBe(before.failures)
  expect(await leaseCount()).toBe(0)
  expect(isLease(await g.acquire(C))).toBe(true)
})

test('a failed trial call re-opens the breaker with a fresh open time', async () => {
  const g = guardFor({ concurrency: 10, calls_per_minute: 1000 })
  await openBreaker(g)
  await migrator.query("UPDATE connection_guards SET opened_at = opened_at - interval '31 seconds'")
  const before = (await guardRow()).opened_at as Date
  const trial = await g.acquire(C)
  if (!isLease(trial)) throw new Error('expected the trial to be granted')
  await g.release(trial.lease, 'failed')
  const row = await guardRow()
  expect(row.opened_at.getTime()).toBeGreaterThan(before.getTime() + 30_000)
  expect(row.trial_lease).toBeNull()
  expect(denied(await g.acquire(C)).reason).toBe('breaker')
})

test('an ok result resets the count of failures in a row', async () => {
  const g = guardFor({ concurrency: 10, calls_per_minute: 1000 })
  const call = async (outcome: 'ok' | 'failed'): Promise<void> => {
    const r = await g.acquire(C)
    if (!isLease(r)) throw new Error('unexpected denial')
    await g.release(r.lease, outcome)
  }
  for (let i = 0; i < 4; i++) await call('failed')
  await call('ok')
  expect((await guardRow()).failures).toBe(0)
  await call('failed')
  expect((await guardRow()).opened_at).toBeNull()
  expect(isLease(await g.acquire(C))).toBe(true)
})

test('releasing the same lease twice counts once', async () => {
  const g = guardFor({ concurrency: 10, calls_per_minute: 1000 })
  const r = await g.acquire(C)
  if (!isLease(r)) throw new Error('unexpected denial')
  await g.release(r.lease, 'failed')
  await g.release(r.lease, 'failed')
  expect((await guardRow()).failures).toBe(1)
})

test('an expired lease frees its concurrency slot', async () => {
  const g = guardFor({ concurrency: 1, calls_per_minute: 1000 })
  expect(isLease(await g.acquire(C))).toBe(true)
  expect(denied(await g.acquire(C)).reason).toBe('concurrency')
  await migrator.query("UPDATE connection_leases SET expires_at = now() - interval '1 second'")
  expect(isLease(await g.acquire(C))).toBe(true)
  expect(await leaseCount()).toBe(1)
})

test('two tenants with the same connection id do not share counters', async () => {
  await createTenant(pool, 'acme')
  const a = guardFor({ concurrency: 1, calls_per_minute: 1000 })
  const b = guardFor({ concurrency: 1, calls_per_minute: 1000 }, 'acme')
  expect(isLease(await a.acquire(C))).toBe(true)
  expect(denied(await a.acquire(C)).reason).toBe('concurrency')
  expect(isLease(await b.acquire(C))).toBe(true)
  expect(await leaseCount('default')).toBe(1)
  expect(await leaseCount('acme')).toBe(1)
})

test('a connection without limits uses the defaults', async () => {
  const g = guardFor(undefined)
  const results = await Promise.all(Array.from({ length: 10 }, () => g.acquire(C)))
  expect(results.filter(isLease)).toHaveLength(4)
})
