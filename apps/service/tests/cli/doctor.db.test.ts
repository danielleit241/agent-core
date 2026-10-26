import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { assertTestDatabase, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { ensureMasterKeyCheck } from '../../src/bootstrap'
import { doctor, runDoctorChecks } from '../../src/cli/doctor'
import type { DoctorDeps } from '../../src/cli/doctor'
import { main } from '../../src/cli/main'

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

const probes: string[] = []
const okProbe: DoctorDeps['probe'] = async (model) => {
  probes.push(model)
  return { probes: [{ ok: true, detail: '1 tool call(s)' }] }
}
const deps = (probe: DoctorDeps['probe'] = okProbe): DoctorDeps => ({
  probe,
  connect: createPool,
})

const dataDir = mkdtempSync(join(tmpdir(), 'doctor-'))
const goodEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: runtimeTestUrl(url),
  MIGRATOR_DATABASE_URL: url,
  AGENT_CORE_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  AGENT_CORE_ADMIN_KEY: 'k',
  AGENT_CORE_DATA_DIR: dataDir,
  LLM_BASE_URL: 'http://llm.test/v1',
  LLM_MODEL_DEFAULT: 'm1',
})
const without = (env: NodeJS.ProcessEnv, ...keys: string[]): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)))
const find = (checks: { name: string }[], name: string) => checks.find((c) => c.name === name)

test('with a good setup every check is ok and the probe asks the default model', async () => {
  probes.length = 0
  const checks = await runDoctorChecks(goodEnv(), deps())
  expect(checks.map((c) => [c.name, c.ok, c.level])).toEqual(
    ['env', 'db', 'migrations', 'runtime_user', 'admin_key', 'master_key', 'llm', 'llm_probe'].map((n) => [n, true, undefined]),
  )
  expect(probes).toEqual(['m1'])
})

test('env: a master key that is not 32 bytes fails and stops the other checks', async () => {
  const checks = await runDoctorChecks({ ...goodEnv(), AGENT_CORE_MASTER_KEY: 'c2hvcnQ=' }, deps())
  expect(checks).toEqual([expect.objectContaining({ name: 'env', ok: false, fix: 'AGENT_CORE_MASTER_KEY must be 32 bytes encoded in base64.' })])
})

test('db: an unreachable database fails and the checks that need it are skipped', async () => {
  const checks = await runDoctorChecks({ ...goodEnv(), DATABASE_URL: 'postgres://agentcore_runtime:x@127.0.0.1:1/none' }, deps())
  expect(find(checks, 'db')).toMatchObject({ ok: false, code: 'db_unreachable' })
  expect(find(checks, 'migrations')).toBeUndefined()
  expect(find(checks, 'runtime_user')).toBeUndefined()
})

test('migrations: a missing migration row fails', async () => {
  await migrator.query("DELETE FROM schema_migrations WHERE name = '010_m2b.sql'")
  expect(find(await runDoctorChecks(goodEnv(), deps()), 'migrations')).toMatchObject({ ok: false, code: 'migrations_pending' })
})

test('runtime_user: a superuser fails', async () => {
  const su = (await migrator.query('SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname = current_user')).rows[0].privileged
  expect(su).toBe(true) // the test login must be privileged for this case to mean something
  expect(find(await runDoctorChecks({ ...goodEnv(), DATABASE_URL: url }, deps()), 'runtime_user')).toMatchObject({ ok: false, code: 'runtime_user_privileged' })
})

test('admin_key: none yet warns; a stored hash is ok; an env key is ok', async () => {
  const noKey = without(goodEnv(), 'AGENT_CORE_ADMIN_KEY')
  expect(find(await runDoctorChecks(noKey, deps()), 'admin_key')).toMatchObject({ ok: true, level: 'warn', code: 'admin_key_not_generated' })
  await migrator.query("INSERT INTO service_settings (name, value) VALUES ('admin_key_hash', $1)", [Buffer.alloc(32)])
  expect(find(await runDoctorChecks(noKey, deps()), 'admin_key')).toEqual({ name: 'admin_key', ok: true })
  expect(find(await runDoctorChecks(goodEnv(), deps()), 'admin_key')).toEqual({ name: 'admin_key', ok: true })
})

test('master_key: a key file warns, an env key is ok', async () => {
  const noKey = without(goodEnv(), 'AGENT_CORE_MASTER_KEY')
  expect(find(await runDoctorChecks(noKey, deps()), 'master_key')).toMatchObject({ ok: true, level: 'warn', code: 'master_key_generated' })
  expect(find(await runDoctorChecks(goodEnv(), deps()), 'master_key')).toEqual({ name: 'master_key', ok: true })
})

test('master_key: a key that differs from the stored check fails, and doctor does not write the check', async () => {
  await ensureMasterKeyCheck(migrator, Buffer.alloc(32, 9), dataDir)
  const checks = await runDoctorChecks(goodEnv(), deps())
  expect(find(checks, 'master_key')).toMatchObject({ ok: false, code: 'master_key_mismatch', fix: expect.stringContaining('AGENT_CORE_MASTER_KEY') })
  await migrator.query('DELETE FROM service_settings WHERE name = $1', ['master_key_check'])
  await runDoctorChecks(goodEnv(), deps())
  expect((await migrator.query('SELECT 1 FROM service_settings WHERE name = $1', ['master_key_check'])).rowCount).toBe(0)
  await ensureMasterKeyCheck(migrator, Buffer.alloc(32, 7), dataDir)
  expect(find(await runDoctorChecks(goodEnv(), deps()), 'master_key')).toEqual({ name: 'master_key', ok: true })
})

test('llm: missing settings fail and the probe is skipped', async () => {
  probes.length = 0
  const noLlm = without(goodEnv(), 'LLM_BASE_URL')
  const checks = await runDoctorChecks(noLlm, deps())
  expect(find(checks, 'llm')).toMatchObject({ ok: false, code: 'llm_not_configured' })
  expect(find(checks, 'llm_probe')).toBeUndefined()
  expect(probes).toEqual([])
})

test('llm_probe: a throw or an HTTP error fails', async () => {
  const thrown = await runDoctorChecks(goodEnv(), deps(async () => { throw new Error('connect ECONNREFUSED secret-host') }))
  expect(find(thrown, 'llm_probe')).toMatchObject({ ok: false, code: 'llm_probe_failed' })
  expect(JSON.stringify(thrown)).not.toContain('secret-host')
  const http = await runDoctorChecks(goodEnv(), deps(async () => ({ probes: [{ ok: false, detail: 'HTTP 401' }] })))
  expect(find(http, 'llm_probe')).toMatchObject({ ok: false })
})

test('doctor writes nothing: no master key file, no admin key hash', async () => {
  const bare = without(goodEnv(), 'AGENT_CORE_ADMIN_KEY', 'AGENT_CORE_MASTER_KEY')
  await runDoctorChecks({ ...bare, AGENT_CORE_DATA_DIR: join(dataDir, 'fresh') }, deps())
  expect(existsSync(join(dataDir, 'fresh'))).toBe(false)
  expect((await migrator.query('SELECT 1 FROM service_settings')).rowCount).toBe(0)
})

test('output lines and exit code: fail gives 1, only ok and warn gives 0', async () => {
  const lines: string[] = []
  const io = { out: (l: string) => void lines.push(l) }
  const noLlm = without(goodEnv(), 'LLM_BASE_URL')
  expect(await doctor(noLlm, io, deps())).toBe(1)
  expect(lines).toContain('ok    db')
  expect(lines).toContain('fail  llm           Set LLM_BASE_URL and LLM_MODEL_DEFAULT, then restart.')
  lines.length = 0
  const noAdmin = without(goodEnv(), 'AGENT_CORE_ADMIN_KEY')
  expect(await main(['doctor'], noAdmin, { out: io.out, err: io.out, fetch }, deps())).toBe(0)
  expect(lines.some((l) => l.startsWith('warn  admin_key'))).toBe(true)
})
