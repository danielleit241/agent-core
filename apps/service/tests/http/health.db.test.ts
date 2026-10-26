import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import { assertTestDatabase, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { buildApp } from '../../src/http/app'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>
let app: FastifyInstance

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  app = buildApp({ secrets: createSecretBox(Buffer.alloc(32, 7)), pool, adminKey: 'k' })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

test('/readyz is 200 ready with db and migrations ok, without auth, and leaks no URL or secret', async () => {
  const res = await app.inject({ method: 'GET', url: '/readyz' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ status: 'ready', checks: [{ name: 'db', ok: true }, { name: 'migrations', ok: true }] })
  expect(res.body).not.toMatch(/postgres:|agentcore_runtime|password/i)
})

test('/readyz is 503 not_ready with migrations_pending when a migration row is missing', async () => {
  await migrator.query("DELETE FROM schema_migrations WHERE name = '010_m2b.sql'")
  const res = await app.inject({ method: 'GET', url: '/readyz' })
  expect(res.statusCode).toBe(503)
  const body = res.json<{ status: string; checks: { name: string; ok: boolean; code?: string; fix?: string }[] }>()
  expect(body.status).toBe('not_ready')
  expect(body.checks.find((c) => c.name === 'migrations')).toMatchObject({ ok: false, code: 'migrations_pending' })
})
