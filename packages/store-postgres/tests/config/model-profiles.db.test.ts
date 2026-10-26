import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { ModelProfile } from '@agent-core/core'
import { ModelProfileRepo, assertTestDatabase, runtimeTestUrl, createPool, runMigrations } from '../../src'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: pg.Pool
let pool: pg.Pool
let repo: ModelProfileRepo

const profile: ModelProfile = { jsonSchemaStrict: true, parallelTools: false, usageCost: true, priceInPerMTok: 1 }
const proposed: ModelProfile = { jsonSchemaStrict: false, parallelTools: true, usageCost: false }
const probes = [{ name: 'tools', ok: true, detail: '1 tool call(s)' }]

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  repo = new ModelProfileRepo(pool)
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

test('get returns null for an unknown model', async () => {
  expect(await repo.get('m1')).toBeNull()
})

test('setProposal stores a proposal and probes, and leaves the profile empty', async () => {
  await repo.setProposal('m1', proposed, probes)
  const row = await repo.get('m1')
  expect(row).toMatchObject({ model: 'm1', profile: null, proposed, probes })
  expect(row?.checkedAt).toBeInstanceOf(Date)
})

test('setProfile stores the profile and keeps an earlier proposal', async () => {
  await repo.setProposal('m1', proposed, probes)
  await repo.setProfile('m1', profile)
  expect(await repo.get('m1')).toMatchObject({ profile, proposed, probes })
})

test('a new proposal does not change a stored profile', async () => {
  await repo.setProfile('m1', profile)
  await repo.setProposal('m1', proposed, probes)
  expect(await repo.get('m1')).toMatchObject({ profile, proposed })
})

test('setProfile on a new model creates a row without a proposal', async () => {
  await repo.setProfile('m2', profile)
  expect(await repo.get('m2')).toMatchObject({ profile, proposed: null, probes: null, checkedAt: null })
})
