import { expect, test } from 'vitest'
import { GENESIS_HASH, hashEvent } from '@agent-core/core'
import type { StoredEvent } from '@agent-core/core'
import { main } from '../../src/cli/main'

function chain(n: number): StoredEvent[] {
  const events: StoredEvent[] = []
  for (let seq = 1; seq <= n; seq++) {
    const partial = {
      tenantId: 'default',
      runId: 'r1',
      seq,
      type: 'llm.requested',
      payload: { model: 'm' },
      labels: ['trusted'],
      agentVersion: 1,
      createdAt: '2026-10-26T00:00:00.000Z',
      prevHash: events.at(-1)?.hash ?? GENESIS_HASH,
    } as Omit<StoredEvent, 'hash'>
    events.push({ ...partial, hash: hashEvent(partial) } as StoredEvent)
  }
  return events
}

const headOf = (events: StoredEvent[]) => ({ last_seq: events.at(-1)?.seq ?? null, last_hash: events.at(-1)?.hash ?? null })

function run(argv: string[], reply: { status?: number; body?: unknown; throws?: boolean }, env: Record<string, string | undefined> = { AGENT_CORE_API_KEY: 'k' }) {
  const out: string[] = []
  const err: string[] = []
  const urls: string[] = []
  const fetchFake = (async (url: string) => {
    urls.push(url)
    if (reply.throws) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
  return main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l), fetch: fetchFake }).then((code) => ({ code, out, err, urls }))
}

test('log verify exits 0 and prints ok for a valid chain', async () => {
  const r = await run(['log', 'verify', 'r1'], { body: { events: chain(3), head: headOf(chain(3)), chain: { valid: true } } })
  expect(r).toMatchObject({ code: 0, out: ['ok: 3 events'], urls: ['http://localhost:7300/v1/runs/r1/events'] })
})

test('log verify exits 1 when an event was edited, and ignores the server chain field', async () => {
  const events = chain(3)
  events[1] = { ...events[1]!, payload: { model: 'edited' } } as StoredEvent
  const r = await run(['log', 'verify', 'r1'], { body: { events, head: headOf(chain(3)), chain: { valid: true } } })
  expect(r).toMatchObject({ code: 1, out: ['broken at seq 2'] })
})

test('log verify exits 2 on 401, on a network error and without a key', async () => {
  expect((await run(['log', 'verify', 'r1'], { status: 401 })).code).toBe(2)
  expect((await run(['log', 'verify', 'r1'], { throws: true })).code).toBe(2)
  const noKey = await run(['log', 'verify', 'r1'], {}, {})
  expect(noKey.code).toBe(2)
  expect(noKey.err[0]).toContain('AGENT_CORE_API_KEY')
})

test('log verify uses AGENT_CORE_URL and prints help', async () => {
  const r = await run(['log', 'verify', 'r1'], { body: { events: chain(1), head: headOf(chain(1)) } }, { AGENT_CORE_API_KEY: 'k', AGENT_CORE_URL: 'http://svc:1/' })
  expect(r.urls).toEqual(['http://svc:1/v1/runs/r1/events'])
  const help = await run(['log', 'verify', '--help'], {})
  expect(help.code).toBe(0)
  expect(help.out[0]).toContain('Usage')
})

test('log verify exits 1 when tail events were deleted', async () => {
  const full = chain(3)
  const r = await run(['log', 'verify', 'r1'], { body: { events: full.slice(0, 2), head: headOf(full), chain: { valid: true } } })
  expect(r).toMatchObject({ code: 1, out: ['broken at seq 3'] })
})

test('log verify exits 1 when every event was deleted but the run has a head', async () => {
  const r = await run(['log', 'verify', 'r1'], { body: { events: [], head: headOf(chain(3)), chain: { valid: true } } })
  expect(r).toMatchObject({ code: 1, out: ['broken at seq 1'] })
})

test('log verify exits 1 when the last event differs from the head hash, and ignores events past the head', async () => {
  const full = chain(3)
  const bad = await run(['log', 'verify', 'r1'], { body: { events: full, head: { last_seq: 3, last_hash: 'x' } } })
  expect(bad).toMatchObject({ code: 1, out: ['broken at seq 3'] })
  const newer = await run(['log', 'verify', 'r1'], { body: { events: full, head: headOf(full.slice(0, 2)) } })
  expect(newer).toMatchObject({ code: 0, out: ['ok: 2 events'] })
})

test('log verify exits 0 for an empty run with an empty head, and 2 when the head is missing', async () => {
  expect(await run(['log', 'verify', 'r1'], { body: { events: [], head: { last_seq: null, last_hash: null } } })).toMatchObject({ code: 0, out: ['ok: 0 events'] })
  expect((await run(['log', 'verify', 'r1'], { body: { events: chain(1) } })).code).toBe(2)
})
