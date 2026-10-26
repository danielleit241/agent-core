import { expect, test } from 'vitest'
import { readServiceConfig } from '../src/config'

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const full: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://agentcore_runtime:pw@localhost:5433/agentcore',
  MIGRATOR_DATABASE_URL: 'postgres://agentcore:pw@localhost:5433/agentcore',
  AGENT_CORE_ADMIN_KEY: 'admin',
  AGENT_CORE_MASTER_KEY: MASTER_KEY,
  LLM_BASE_URL: 'http://llm.test/v1',
  LLM_MODEL_DEFAULT: 'm1',
}

test('a full env', () => {
  const c = readServiceConfig({ ...full, LLM_MODEL_SMART: 'm2', LLM_API_KEY: 'k', PORT: '8080' })
  expect(c).toMatchObject({
    ok: true,
    databaseUrl: full.DATABASE_URL,
    migratorUrl: full.MIGRATOR_DATABASE_URL,
    adminKey: 'admin',
    llm: { baseUrl: 'http://llm.test/v1', apiKey: 'k', models: { default: 'm1', smart: 'm2' } },
    port: 8080,
  })
  expect(c.ok && c.masterKey?.equals(Buffer.alloc(32, 7))).toBe(true)
})

test('defaults: port 7300, empty llm api key, only the default model', () => {
  expect(readServiceConfig(full)).toMatchObject({
    ok: true,
    port: 7300,
    dataDir: './.data',
    llm: { apiKey: '', models: { default: 'm1' } },
  })
})

test('missing MIGRATOR_DATABASE_URL', () => {
  const env = { ...full, MIGRATOR_DATABASE_URL: undefined }
  expect(readServiceConfig(env)).toEqual({ ok: false, error: 'missing required environment variable(s): MIGRATOR_DATABASE_URL' })
})

test('only the two database URLs are required', () => {
  const c = readServiceConfig({ DATABASE_URL: full.DATABASE_URL, MIGRATOR_DATABASE_URL: full.MIGRATOR_DATABASE_URL })
  expect(c).toMatchObject({ ok: true, adminKey: null, masterKey: null, llm: null })
})

test.each(['LLM_BASE_URL', 'LLM_MODEL_DEFAULT'] as const)('without %s the llm is null', (name) => {
  expect(readServiceConfig({ ...full, [name]: undefined })).toMatchObject({ ok: true, llm: null })
})

test('AGENT_CORE_DATA_DIR sets the data directory', () => {
  expect(readServiceConfig({ ...full, AGENT_CORE_DATA_DIR: '/data' })).toMatchObject({ ok: true, dataDir: '/data' })
})

test('missing DATABASE_URL', () => {
  const env = { ...full, DATABASE_URL: undefined }
  expect(readServiceConfig(env)).toEqual({ ok: false, error: 'missing required environment variable(s): DATABASE_URL' })
})

test('master key of 16 bytes', () => {
  const short = Buffer.alloc(16, 9).toString('base64')
  const c = readServiceConfig({ ...full, AGENT_CORE_MASTER_KEY: short })
  expect(c.ok).toBe(false)
  if (!c.ok) {
    expect(c.error).toContain('AGENT_CORE_MASTER_KEY')
    expect(c.error).not.toContain(short)
  }
})

test('a bad PORT', () => {
  expect(readServiceConfig({ ...full, PORT: '70000' })).toEqual({ ok: false, error: 'PORT must be an integer from 1 to 65535' })
})

test.each(['DATABASE_URL', 'MIGRATOR_DATABASE_URL'] as const)('a malformed %s with a password is rejected without echoing it', (name) => {
  const c = readServiceConfig({ ...full, [name]: 'postgres://user:s3cr3t-pw@bad host:5433/db' })
  expect(c).toEqual({ ok: false, error: `${name} must be a valid postgres URL with a user name` })
  expect(JSON.stringify(c)).not.toContain('s3cr3t-pw')
})

test('DATABASE_URL without a user name is rejected', () => {
  const c = readServiceConfig({ ...full, DATABASE_URL: 'postgres://:s3cr3t-pw@localhost:5433/db' })
  expect(c).toEqual({ ok: false, error: 'DATABASE_URL must be a valid postgres URL with a user name' })
})
