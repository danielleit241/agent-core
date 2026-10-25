// Checks what each model alias can do and prints the proposals. With --apply, stores them as the profiles.
const baseUrl = (process.env.AGENT_CORE_URL ?? 'http://localhost:7300').replace(/\/+$/, '')
const adminKey = process.env.AGENT_CORE_ADMIN_KEY
if (!adminKey) {
  console.error('models:check: set AGENT_CORE_ADMIN_KEY')
  process.exit(1)
}
const apply = process.argv.includes('--apply')

type Probe = { name: string; ok: boolean; detail: string }
type Entry = { alias: string; model: string; proposed: Record<string, unknown> | null; probes: Probe[] | null }

async function call(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  const json: unknown = await res.json().catch(() => undefined)
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new Error(`${method} ${path} failed with HTTP ${res.status}${err ? `: ${err.code}: ${err.message}` : ''}`)
  }
  return json
}

async function main(): Promise<void> {
  const { models } = (await call('POST', '/v1/models/check', {})) as { models: Entry[] }
  for (const m of models) {
    console.log(`${m.alias} (${m.model}): proposed ${JSON.stringify(m.proposed)}`)
    for (const p of m.probes ?? []) console.log(`  ${p.ok ? 'ok  ' : 'fail'} ${p.name}: ${p.detail}`)
  }
  if (!apply) {
    console.log('Run with --apply to store the proposals as profiles.')
    return
  }
  for (const m of models) {
    await call('PATCH', `/v1/models/${encodeURIComponent(m.alias)}`, { apply: 'proposed' })
    console.log(`${m.alias}: profile stored`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
