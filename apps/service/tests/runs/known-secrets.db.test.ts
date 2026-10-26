import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import { ConfigRepo, assertTestDatabase, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { knownSecretValues } from '../../src/runs/known-secrets'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>

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

test('collects the connection secrets and URL passwords of the agent, the tenant webhook secrets and the LLM key', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  await config.putConnection({ id: 'shop', kind: 'webhook', url: 'https://u:p%40ss-word-1@shop.example.com/x', secret: 'shop-signing-secret', tools: [] })
  await config.putConnection({ id: 'other', kind: 'mcp', url: 'https://other.example.com/mcp', secret: 'other-connection-secret', tools: [] })
  await config.putWebhook({ id: 'wh1', url: 'https://hooks.example.com/in', secret: 'webhook-signing-secret', events: [] })
  const values = await knownSecretValues(config, { connections: ['shop', 'missing'] }, 'llm-api-key-value')
  expect(values.sort()).toEqual(['llm-api-key-value', 'p%40ss-word-1', 'p@ss-word-1', 'shop-signing-secret', 'webhook-signing-secret'].sort())
  expect(await knownSecretValues(config, { connections: [] }, undefined)).toEqual(['webhook-signing-secret'])
})

test('a webhook secret that cannot be decrypted is skipped, with a log naming only the row id', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  await config.putWebhook({ id: 'bad-hook', url: 'https://hooks.example.com/a', secret: 'webhook-signing-secret', events: [] })
  await config.putWebhook({ id: 'good-hook', url: 'https://hooks.example.com/b', secret: 'second-webhook-secret', events: [] })
  await migrator.query("UPDATE webhooks SET secret = 'not-a-sealed-value' WHERE id = 'bad-hook'")
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    expect(await knownSecretValues(config, { connections: [] }, undefined)).toEqual(['second-webhook-secret'])
    expect(logged.mock.calls.flat().join(' ')).toContain('bad-hook')
    expect(logged.mock.calls.flat().join(' ')).not.toContain('webhook-signing-secret')
  } finally {
    logged.mockRestore()
  }
})

test('a connection secret that cannot be decrypted is skipped', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  await config.putConnection({ id: 'bad', kind: 'webhook', url: 'https://x.example.com', secret: 'bad-connection-secret', tools: [] })
  await config.putConnection({ id: 'good', kind: 'webhook', url: 'https://y.example.com', secret: 'good-connection-secret', tools: [] })
  await migrator.query("UPDATE connections SET secret = 'not-a-sealed-value' WHERE id = 'bad'")
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    expect(await knownSecretValues(config, { connections: ['bad', 'good'] }, undefined)).toEqual(['good-connection-secret'])
  } finally {
    logged.mockRestore()
  }
})

test('a URL password that is not valid percent-encoding is still collected as written', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  await config.putConnection({ id: 'odd', kind: 'webhook', url: 'https://u:p%zzword1234@odd.example.com/x', tools: [] })
  expect(await knownSecretValues(config, { connections: ['odd'] }, undefined)).toEqual(['p%zzword1234'])
})

test('connections the caller already loaded are not read again', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  const values = await knownSecretValues(config, { connections: ['never-read'] }, undefined, [{ secret: 'loaded-connection-secret', url: 'https://u:loaded-pass-1@h.example.com' }])
  expect(values.sort()).toEqual(['loaded-connection-secret', 'loaded-pass-1'])
})
