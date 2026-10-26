import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { assertTestDatabase, createPool, InvalidTenantError, runMigrations, runtimeTestUrl, withClaim, withTenant } from '../../src'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: pg.Pool
let runtime: pg.Pool

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  runtime = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
})
afterAll(async () => {
  await runtime.end()
  await migrator.end()
})

const HASH = 'a'.repeat(64)
const TABLES = ['tenants', 'api_keys', 'agents', 'connections', 'runs', 'events', 'queue', 'webhooks', 'webhook_deliveries', 'idempotency_keys', 'connection_guards', 'connection_leases']
/** Tables where agentcore_app holds DELETE. */
const DELETABLE = ['queue', 'idempotency_keys', 'connection_guards', 'connection_leases']
/** One UPDATE per table where agentcore_app holds UPDATE; it matches every visible row. */
const UPDATES: Record<string, string> = {
  agents: 'UPDATE agents SET version = version',
  connections: 'UPDATE connections SET kind = kind',
  runs: 'UPDATE runs SET status = status',
  queue: 'UPDATE queue SET priority = priority',
  webhook_deliveries: 'UPDATE webhook_deliveries SET attempts = attempts',
  idempotency_keys: 'UPDATE idempotency_keys SET status_code = status_code',
  connection_guards: 'UPDATE connection_guards SET failures = failures',
  connection_leases: 'UPDATE connection_leases SET expires_at = expires_at',
}

async function seed(tenant: string): Promise<void> {
  await withTenant(runtime, tenant, async (c) => {
    await c.query('INSERT INTO tenants (id) VALUES ($1)', [tenant])
    await c.query("INSERT INTO api_keys (tenant_id, id, key_hash) VALUES ($1, 'k1', '\\x00')", [tenant])
    await c.query("INSERT INTO agents (tenant_id, id, definition) VALUES ($1, 'ag', '{}')", [tenant])
    await c.query("INSERT INTO connections (tenant_id, id, kind, url, tools) VALUES ($1, 'cn', 'mcp', 'http://x', '[]')", [tenant])
    await c.query("INSERT INTO runs (tenant_id, id, agent_id, agent_version, status) VALUES ($1, 'r1', 'ag', 1, 'queued')", [tenant])
    await c.query(
      `INSERT INTO events (tenant_id, run_id, seq, type, payload, labels, agent_version, created_at, prev_hash, hash)
       VALUES ($1, 'r1', 1, 't', '{}', '{}', 1, now(), $2, $2)`,
      [tenant, HASH],
    )
    await c.query("INSERT INTO queue (run_id, tenant_id) VALUES ('r1', $1)", [tenant])
    await c.query("INSERT INTO webhooks (tenant_id, id, url, secret, events) VALUES ($1, 'w1', 'http://x', 's', '{}')", [tenant])
    await c.query("INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event_id, type, body) VALUES ('d1', $1, 'w1', 'e1', 't', 'b')", [tenant])
    await c.query("INSERT INTO idempotency_keys (tenant_id, key, request_hash) VALUES ($1, 'k', $2)", [tenant, HASH])
    await c.query("INSERT INTO connection_guards (tenant_id, connection_id, window_start) VALUES ($1, 'cn', now())", [tenant])
    await c.query("INSERT INTO connection_leases (id, tenant_id, connection_id, expires_at) VALUES (gen_random_uuid(), $1, 'cn', now())", [tenant])
  })
}

test('T-1 every table with tenant_id has RLS and FORCE', async () => {
  const res = await migrator.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
        AND (c.relname = 'tenants' OR EXISTS (SELECT 1 FROM information_schema.columns k
              WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'tenant_id'))`,
  )
  expect(res.rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort())
  for (const r of res.rows) {
    expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true])
  }
})

test('T-1 runtime roles have no bypass', async () => {
  const res = await migrator.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('agentcore_app', 'agentcore_claim', 'agentcore_runtime')",
  )
  expect(res.rows).toHaveLength(3)
  for (const r of res.rows) expect([r.rolname, r.rolsuper, r.rolbypassrls]).toEqual([r.rolname, false, false])
  const owned = await migrator.query(
    "SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname IN ('agentcore_app', 'agentcore_claim', 'agentcore_runtime')",
  )
  expect(owned.rowCount).toBe(0)
})

test('T-1 agentcore_app cannot update or delete events', async () => {
  const res = await migrator.query<{ u: boolean; d: boolean }>(
    "SELECT has_table_privilege('agentcore_app', 'events', 'UPDATE') AS u, has_table_privilege('agentcore_app', 'events', 'DELETE') AS d",
  )
  expect(res.rows[0]).toEqual({ u: false, d: false })
})

test('T-2 no tenant set reads zero rows', async () => {
  await seed('a')
  const client = await runtime.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE agentcore_app')
    for (const t of TABLES) {
      const res = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)
      expect([t, res.rows[0]?.n]).toEqual([t, '0'])
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})

test('T-3 tenant b cannot read, update or delete rows of a', async () => {
  await seed('a')
  await withTenant(runtime, 'b', async (c) => {
    for (const t of TABLES) {
      expect([t, (await c.query(`SELECT 1 FROM ${t}`)).rowCount]).toEqual([t, 0])
    }
    for (const [t, sql] of Object.entries(UPDATES)) expect([t, (await c.query(sql)).rowCount]).toEqual([t, 0])
    for (const t of DELETABLE) expect([t, (await c.query(`DELETE FROM ${t}`)).rowCount]).toEqual([t, 0])
  })
  // tenant a still sees its rows
  await withTenant(runtime, 'a', async (c) => {
    for (const t of TABLES) expect([t, (await c.query(`SELECT 1 FROM ${t}`)).rowCount]).toEqual([t, 1])
  })
})

test('T-3 insert with another tenant_id is refused', async () => {
  await expect(
    withTenant(runtime, 'b', (c) => c.query("INSERT INTO agents (tenant_id, id, definition) VALUES ('a', 'ag', '{}')")),
  ).rejects.toMatchObject({ code: '42501' })
})

test('T-4 runtime user without SET ROLE is denied', async () => {
  await expect(runtime.query('SELECT 1 FROM public.runs')).rejects.toMatchObject({ code: '42501' })
})

test('T-5 a returned connection carries no role or tenant', async () => {
  const single = new pg.Pool({ connectionString: runtimeTestUrl(url), max: 1 })
  try {
    await expect(
      withTenant(single, 'a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await withTenant(single, 'a', (c) => c.query('SELECT 1'))
    const res = await single.query<{ current_user: string; t: string | null }>(
      "SELECT current_user, current_setting('app.tenant_id', true) AS t",
    )
    expect(res.rows[0]?.current_user).toBe('agentcore_runtime')
    expect(['', null]).toContain(res.rows[0]?.t)
  } finally {
    await single.end()
  }
})

test('T-6 claim role cannot read deliveries body, run data other than status, or events', async () => {
  await seed('a')
  await expect(withClaim(runtime, (c) => c.query('SELECT body FROM webhook_deliveries'))).rejects.toMatchObject({ code: '42501' })
  await expect(withClaim(runtime, (c) => c.query('SELECT agent_id FROM runs'))).rejects.toMatchObject({ code: '42501' })
  // The status column alone is readable, for the run counts in /metrics.
  await expect(withClaim(runtime, (c) => c.query('SELECT status FROM runs'))).resolves.toMatchObject({ rowCount: 1 })
  await expect(withClaim(runtime, (c) => c.query('SELECT 1 FROM events'))).rejects.toMatchObject({ code: '42501' })
  const scan = await withClaim(runtime, (c) => c.query('SELECT id, tenant_id, status, next_attempt_at FROM webhook_deliveries'))
  expect(scan.rowCount).toBe(1)
})

test.each(["a'; DROP TABLE runs; --", 'A', 'a.b', 'a'.repeat(65), ''])('withTenant rejects a malformed tenant id before connecting: %s', async (id) => {
  const fake = {
    connect: () => {
      throw new Error('connect must not be called')
    },
  } as unknown as pg.Pool
  await expect(withTenant(fake, id, async () => 1)).rejects.toBeInstanceOf(InvalidTenantError)
})

test('an ordinary error keeps the pooled connection; only a failed ROLLBACK drops it', async () => {
  const single = new pg.Pool({ connectionString: runtimeTestUrl(url), max: 1 })
  try {
    const pidOf = () => withTenant(single, 'a', async (c) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
    const before = await pidOf()
    await expect(
      withTenant(single, 'a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await pidOf()).toBe(before)
  } finally {
    await single.end()
  }

  const released: unknown[] = []
  const fakePool = (rollbackFails: boolean) =>
    ({
      connect: async () => ({
        query: async (sql: string) => {
          if (sql === 'ROLLBACK' && rollbackFails) throw new Error('connection lost')
          return { rows: [], rowCount: 0 }
        },
        release: (err?: unknown) => released.push(err),
      }),
    }) as unknown as pg.Pool
  const fail = () => Promise.reject(new Error('domain error'))
  await expect(withTenant(fakePool(false), 'a', fail)).rejects.toThrow('domain error')
  await expect(withTenant(fakePool(true), 'a', fail)).rejects.toThrow('domain error')
  expect(released[0]).toBeUndefined()
  expect(released[1]).toBeInstanceOf(Error)
})
