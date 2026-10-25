import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const posix = (p: string) => p.split(sep).join('/')

interface Manifest {
  name: string
  dir: string
  file: string
  dependencies: string[]
  devDependencies: string[]
  peerDependencies: string[]
}

function manifestsUnder(top: string): Manifest[] {
  const base = join(ROOT, top)
  const files = readdirSync(base, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('package.json') && !f.split(sep).includes('node_modules'))
    .map((f) => join(base, f))
  return files.map((path) => {
    const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const keys = (field: string) => Object.keys((json[field] ?? {}) as Record<string, string>)
    return {
      name: String(json.name),
      dir: dirname(path),
      file: posix(relative(ROOT, path)),
      dependencies: keys('dependencies'),
      devDependencies: keys('devDependencies'),
      peerDependencies: keys('peerDependencies'),
    }
  })
}

const packages = manifestsUnder('packages')
const kindOf = new Map<string, string>()
for (const top of ['packages', 'apps', 'mocks']) {
  for (const m of manifestsUnder(top)) kindOf.set(m.name, top)
}
const topOf = (dep: string) => kindOf.get(dep)

test('library packages never depend on apps or mocks at runtime, nor on apps in dev', () => {
  expect(packages.length).toBeGreaterThan(0)
  const violations: string[] = []
  for (const m of packages) {
    for (const dep of [...m.dependencies, ...m.peerDependencies]) {
      if (topOf(dep) === 'apps' || topOf(dep) === 'mocks') violations.push(`${m.file}: runtime dependency ${dep} lives under ${topOf(dep)}/`)
    }
    for (const dep of m.devDependencies) {
      if (topOf(dep) === 'apps') violations.push(`${m.file}: devDependency ${dep} lives under apps/`)
    }
  }
  expect(violations).toEqual([])
})

test('packages are one level deep', () => {
  const nested = packages.filter((m) => posix(relative(ROOT, m.dir)).split('/').length !== 2)
  expect(nested.map((m) => m.file)).toEqual([])
})

test('no test files under src/', () => {
  // Walk only each package's src/, so node_modules is never read.
  const misplaced = ['packages', 'apps', 'mocks'].flatMap((top) =>
    readdirSync(join(ROOT, top)).flatMap((pkg) => {
      const src = join(ROOT, top, pkg, 'src')
      if (!existsSync(src)) return []
      return readdirSync(src, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => `${top}/${pkg}/src/${posix(f)}`)
    }),
  )
  expect(misplaced).toEqual([])
})

test('adapters depend at runtime only on core and protocol among workspace packages', () => {
  const adapters = packages.filter((m) => m.name !== '@agent-core/core' && m.name !== '@agent-core/protocol')
  expect(adapters.length).toBeGreaterThan(0)
  const violations: string[] = []
  for (const m of adapters) {
    for (const dep of m.dependencies) {
      if (dep.startsWith('@agent-core/') && dep !== '@agent-core/core' && dep !== '@agent-core/protocol') {
        violations.push(`${m.file}: runtime dependency ${dep}`)
      }
    }
  }
  expect(violations).toEqual([])
})

test('protocol has no dependencies and imports only node:crypto and its own files', () => {
  const protocol = packages.find((m) => m.name === '@agent-core/protocol')
  expect(protocol, 'packages/protocol/package.json is missing').toBeDefined()
  expect(protocol!.dependencies, `${protocol!.file}: dependencies`).toEqual([])
  const src = join(protocol!.dir, 'src')
  const IMPORT_RE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => resolve(src, f))
  expect(files.length).toBeGreaterThan(0)
  const violations: string[] = []
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const spec = m[1]!
      if (spec.startsWith('.')) {
        if (relative(src, resolve(dirname(file), spec)).startsWith('..')) violations.push(`${relative(src, file)} -> ${spec}`)
      } else if (spec !== 'node:crypto') {
        violations.push(`${relative(src, file)} -> ${spec}`)
      }
    }
  }
  expect(violations).toEqual([])
})
