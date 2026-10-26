import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { assertTestDatabase, createPool, runMigrations } from '../../src'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: pg.Pool

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
})
afterAll(async () => {
  await migrator.end()
})

test('an empty runtime user fails loudly instead of skipping the grant', async () => {
  await expect(runMigrations(migrator, { runtimeUser: '' })).rejects.toThrow('DATABASE_URL must name a user (the runtime login role)')
})

test('PostgreSQL older than 16 is refused before the grant', async () => {
  const old = {
    connect: () => migrator.connect(),
    query: (sql: string, params?: unknown[]) =>
      sql.includes('server_version_num') ? Promise.resolve({ rows: [{ v: 150000 }], rowCount: 1 }) : migrator.query(sql, params),
  } as unknown as pg.Pool
  await expect(runMigrations(old, { runtimeUser: 'agentcore_runtime' })).rejects.toThrow('PostgreSQL 16 or newer is required')
})

test('without a runtime user the migrations still run', async () => {
  await runMigrations(migrator)
  expect((await migrator.query("SELECT 1 FROM schema_migrations")).rowCount).toBeGreaterThan(0)
})
