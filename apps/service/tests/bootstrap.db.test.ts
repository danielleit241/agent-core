import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { assertTestDatabase, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { ensureAdminKeyHash } from '../src/bootstrap'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: ReturnType<typeof createPool>

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
})
afterAll(async () => {
  await migrator.end()
})

const KEY = /ak_admin\.[A-Za-z0-9_-]{43}/
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest()

test('generates, prints once and stores only the hash', async () => {
  const lines: string[] = []
  const res = await ensureAdminKeyHash(migrator, null, (l) => lines.push(l))
  expect(res.source).toBe('generated')
  expect(lines).toHaveLength(1)
  const key = KEY.exec(lines[0]!)![0]
  expect(res.hash.equals(sha256(key))).toBe(true)
  const rows = await migrator.query<{ value: Buffer }>('SELECT value FROM service_settings')
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]!.value).toHaveLength(32)
  expect(rows.rows[0]!.value.equals(Buffer.from(key))).toBe(false)
})

test('the second start prints nothing and keeps the same hash', async () => {
  const first = await ensureAdminKeyHash(migrator, null, () => {})
  const lines: string[] = []
  const second = await ensureAdminKeyHash(migrator, null, (l) => lines.push(l))
  expect(lines).toEqual([])
  expect(second.source).toBe('stored')
  expect(second.hash.equals(first.hash)).toBe(true)
})

test('an env key wins and nothing is stored', async () => {
  const lines: string[] = []
  const res = await ensureAdminKeyHash(migrator, 'my-key', (l) => lines.push(l))
  expect(res.source).toBe('env')
  expect(res.hash.equals(sha256('my-key'))).toBe(true)
  expect(lines).toEqual([])
  expect((await migrator.query('SELECT 1 FROM service_settings')).rowCount).toBe(0)
})

test('two concurrent starts on an empty table print exactly one key and agree on the hash', async () => {
  const lines: string[] = []
  const other = createPool(url)
  try {
    const [a, b] = await Promise.all([
      ensureAdminKeyHash(migrator, null, (l) => lines.push(l)),
      ensureAdminKeyHash(other, null, (l) => lines.push(l)),
    ])
    expect(lines).toHaveLength(1)
    expect(a.hash.equals(b.hash)).toBe(true)
    expect(a.hash.equals(sha256(KEY.exec(lines[0]!)![0]))).toBe(true)
  } finally {
    await other.end()
  }
})

test('the scope roles cannot read service_settings', async () => {
  const runtime = createPool(runtimeTestUrl(url))
  try {
    for (const role of ['agentcore_app', 'agentcore_claim']) {
      const client = await runtime.connect()
      try {
        await client.query(`SET ROLE ${role}`)
        await expect(client.query('SELECT * FROM service_settings')).rejects.toThrow(/permission denied/)
      } finally {
        client.release(true)
      }
    }
  } finally {
    await runtime.end()
  }
})
