import { hashAdminKey } from '../../../src/bootstrap'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { DEFAULT_MODEL_PROFILE } from '@agent-core/core'
import { assertTestDatabase, createPool, runtimeTestUrl, runMigrations } from '@agent-core/store-postgres'
import { buildApp } from '../../../src/http/app'
import type { ProbeResult } from '../../../src/http/routes/models'
import { createSecretBox } from '@agent-core/core'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
const ADMIN_KEY = 'test-admin-key'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>
let app: FastifyInstance
let probed: string[]
let probeFails: boolean

const result: ProbeResult = {
  proposed: { jsonSchemaStrict: true, parallelTools: true, usageCost: false },
  probes: [{ name: 'tools', ok: true, detail: '1 tool call(s)' }],
}
const probe = async (model: string): Promise<ProbeResult> => {
  probed.push(model)
  if (probeFails) throw new Error('boom https://secret.example/v1 key=abc')
  return result
}

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  probed = []
  probeFails = false
  app = buildApp({ secrets: box, pool, adminKeyHash: hashAdminKey(ADMIN_KEY), models: { default: 'real-a', smart: 'real-b' }, probe })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

function authed(method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown) {
  return app.inject({ method, url: path, payload: payload as object | undefined, headers: { authorization: `Bearer ${ADMIN_KEY}` } })
}

test('GET lists aliases with the default profile as effective', async () => {
  const res = await authed('GET', '/v1/models')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({
    models: [
      { alias: 'default', model: 'real-a', profile: null, effective: DEFAULT_MODEL_PROFILE, proposed: null, probes: null, checked_at: null },
      { alias: 'smart', model: 'real-b', profile: null, effective: DEFAULT_MODEL_PROFILE, proposed: null, probes: null, checked_at: null },
    ],
  })
})

test('requires the admin key', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/models' })
  expect(res.statusCode).toBe(401)
})

test('check without a body probes every alias and stores proposals only', async () => {
  const res = await authed('POST', '/v1/models/check')
  expect(res.statusCode).toBe(200)
  expect(probed).toEqual(['real-a', 'real-b'])
  const [first] = res.json().models
  expect(first).toMatchObject({ alias: 'default', profile: null, effective: DEFAULT_MODEL_PROFILE, proposed: result.proposed, probes: result.probes })
  expect(typeof first.checked_at).toBe('string')
})

test('check with an alias probes only that alias', async () => {
  const res = await authed('POST', '/v1/models/check', { alias: 'smart' })
  expect(res.statusCode).toBe(200)
  expect(probed).toEqual(['real-b'])
  expect(res.json().models).toHaveLength(1)
})

test('check with an unknown alias is 404 and probes nothing', async () => {
  const res = await authed('POST', '/v1/models/check', { alias: 'nope' })
  expect(res.statusCode).toBe(404)
  expect(res.json().error.code).toBe('unknown_model_alias')
  expect(probed).toEqual([])
})

test('check without a probe is 501', async () => {
  app = buildApp({ secrets: box, pool, adminKeyHash: hashAdminKey(ADMIN_KEY), models: { default: 'real-a' } })
  const res = await authed('POST', '/v1/models/check')
  expect(res.statusCode).toBe(501)
  expect(res.json().error.code).toBe('model_check_unavailable')
})

test('a failing probe is 502 and the message names the alias only', async () => {
  probeFails = true
  const res = await authed('POST', '/v1/models/check', { alias: 'default' })
  expect(res.statusCode).toBe(502)
  expect(res.json().error.code).toBe('model_check_failed')
  expect(res.body).toContain('default')
  expect(res.body).not.toContain('secret.example')
  expect(res.body).not.toContain('abc')
})

test('PATCH apply proposed sets the profile', async () => {
  await authed('POST', '/v1/models/check', { alias: 'default' })
  const res = await authed('PATCH', '/v1/models/default', { apply: 'proposed' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ alias: 'default', profile: result.proposed, effective: result.proposed })
  expect((await authed('GET', '/v1/models')).json().models[0].profile).toEqual(result.proposed)
})

test('PATCH apply proposed without a proposal is 409', async () => {
  const res = await authed('PATCH', '/v1/models/default', { apply: 'proposed' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('no_proposal')
})

test('PATCH with a full profile sets it; a check afterwards does not change it', async () => {
  const profile = { jsonSchemaStrict: false, parallelTools: true, usageCost: true, priceInPerMTok: 2 }
  expect((await authed('PATCH', '/v1/models/smart', profile)).statusCode).toBe(200)
  await authed('POST', '/v1/models/check', { alias: 'smart' })
  const smart = (await authed('GET', '/v1/models')).json().models[1]
  expect(smart).toMatchObject({ profile, effective: profile, proposed: result.proposed })
})

test('PATCH rejects an invalid profile and an unknown alias', async () => {
  expect((await authed('PATCH', '/v1/models/default', { jsonSchemaStrict: true })).statusCode).toBe(400)
  const res = await authed('PATCH', '/v1/models/nope', { apply: 'proposed' })
  expect(res.statusCode).toBe(404)
  expect(res.json().error.code).toBe('unknown_model_alias')
})

test('PATCH apply proposed keeps the prices of the stored profile', async () => {
  await authed('PATCH', '/v1/models/default', { ...DEFAULT_MODEL_PROFILE, priceInPerMTok: 1, priceOutPerMTok: 4 })
  await authed('POST', '/v1/models/check', { alias: 'default' })
  const res = await authed('PATCH', '/v1/models/default', { apply: 'proposed' })
  expect(res.json().profile).toEqual({ ...result.proposed, priceInPerMTok: 1, priceOutPerMTok: 4 })
})

test('PATCH errors name the missing fields', async () => {
  const res = await authed('PATCH', '/v1/models/default', { jsonSchemaStrict: true })
  expect(res.json().error.message).toContain('parallelTools')
  expect(res.json().error.message).toContain('usageCost')
  const apply = await authed('PATCH', '/v1/models/default', { apply: 'yes' })
  expect(apply.statusCode).toBe(400)
  expect(apply.json().error.message).toContain('apply')
})

test('check probes each model once and in parallel, even when two aliases share it', async () => {
  let running = 0
  let peak = 0
  const slow = async (model: string): Promise<ProbeResult> => {
    probed.push(model)
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 30))
    running--
    return result
  }
  const shared = buildApp({ secrets: box, pool, adminKeyHash: hashAdminKey(ADMIN_KEY), models: { default: 'real-a', smart: 'real-b', cheap: 'real-a' }, probe: slow })
  const res = await shared.inject({ method: 'POST', url: '/v1/models/check', headers: { authorization: `Bearer ${ADMIN_KEY}` } })
  expect(res.statusCode).toBe(200)
  expect(probed.sort()).toEqual(['real-a', 'real-b'])
  expect(peak).toBe(2)
  expect(res.json().models.map((m: { alias: string; proposed: unknown }) => [m.alias, m.proposed])).toEqual([
    ['default', result.proposed],
    ['smart', result.proposed],
    ['cheap', result.proposed],
  ])
})

test('when one probe fails, the others are still stored and the error names the failed alias', async () => {
  const half = async (model: string): Promise<ProbeResult> => {
    if (model === 'real-b') throw new Error('boom')
    return result
  }
  const mixed = buildApp({ secrets: box, pool, adminKeyHash: hashAdminKey(ADMIN_KEY), models: { default: 'real-a', smart: 'real-b' }, probe: half })
  const res = await mixed.inject({ method: 'POST', url: '/v1/models/check', headers: { authorization: `Bearer ${ADMIN_KEY}` } })
  expect(res.statusCode).toBe(502)
  expect(res.json().error.message).toBe('The model check failed for alias "smart".')
  expect((await authed('GET', '/v1/models')).json().models[0].proposed).toEqual(result.proposed)
})
