import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ensureMasterKey } from '../src/bootstrap'

const dir = () => mkdtempSync(join(tmpdir(), 'agent-core-mk-'))

test('master key: the env key wins and no file is written', () => {
  const d = dir()
  const env = Buffer.alloc(32, 5)
  expect(ensureMasterKey(env, d, () => {})).toEqual({ key: env, source: 'env' })
  expect(() => readFileSync(join(d, 'master.key'))).toThrow()
})

test('master key: generates a file with mode 0600 when missing and warns without the key', () => {
  const d = join(dir(), 'nested')
  const warnings: string[] = []
  const first = ensureMasterKey(null, d, (l) => warnings.push(l))
  expect(first.source).toBe('file')
  expect(first.key).toHaveLength(32)
  const file = join(d, 'master.key')
  expect(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64').equals(first.key)).toBe(true)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).not.toContain(first.key.toString('base64'))
})

test('master key: reuses an existing file without a warning', () => {
  const d = dir()
  const first = ensureMasterKey(null, d, () => {})
  const warnings: string[] = []
  const second = ensureMasterKey(null, d, (l) => warnings.push(l))
  expect(second.key.equals(first.key)).toBe(true)
  expect(warnings).toEqual([])
})

test('master key: a file of the wrong length is an error that does not echo the content', () => {
  const d = dir()
  const content = Buffer.alloc(16, 9).toString('base64')
  writeFileSync(join(d, 'master.key'), content)
  expect(() => ensureMasterKey(null, d, () => {})).toThrow(/32 bytes/)
  expect(() => ensureMasterKey(null, d, () => {})).not.toThrow(new RegExp(content.replace(/[+/=]/g, '.')))
})
