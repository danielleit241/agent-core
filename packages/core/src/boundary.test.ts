import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

test('core may not import adapters', async () => {
  const eslint = new ESLint()
  const [res] = await eslint.lintText("import '@agent-core/store-postgres'\n", {
    filePath: 'packages/core/src/x.ts',
  })
  expect(res.messages.map((m) => m.ruleId)).toContain('no-restricted-imports')
})

test('core may import zod', async () => {
  const eslint = new ESLint()
  const [res] = await eslint.lintText("import { z } from 'zod'\n", {
    filePath: 'packages/core/src/x.ts',
  })
  expect(res.messages.filter((m) => m.ruleId === 'no-restricted-imports')).toHaveLength(0)
})

const SRC = dirname(fileURLToPath(import.meta.url))
const sourceFiles = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => resolve(SRC, f))
const IMPORT_RE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g

test('core sources import only zod, node:crypto and files inside packages/core/src', () => {
  expect(sourceFiles.length).toBeGreaterThan(0)
  const violations: string[] = []
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1]!
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec)
        if (relative(SRC, target).startsWith('..')) {
          violations.push(`${relative(SRC, file)} -> ${spec}`)
        }
      } else if (spec !== 'zod' && spec !== 'node:crypto') {
        violations.push(`${relative(SRC, file)} -> ${spec}`)
      }
    }
  }
  expect(violations).toEqual([])
})
