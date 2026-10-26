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
  const r = await run(['log', 'verify', 'r1'], { body: { events: chain(3), chain: { valid: true } } })
  expect(r).toMatchObject({ code: 0, out: ['ok: 3 events'], urls: ['http://localhost:7300/v1/runs/r1/events'] })
})

test('log verify exits 1 when an event was edited, and ignores the server chain field', async () => {
  const events = chain(3)
  events[1] = { ...events[1]!, payload: { model: 'edited' } } as StoredEvent
  const r = await run(['log', 'verify', 'r1'], { body: { events, chain: { valid: true } } })
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
  const r = await run(['log', 'verify', 'r1'], { body: { events: chain(1) } }, { AGENT_CORE_API_KEY: 'k', AGENT_CORE_URL: 'http://svc:1/' })
  expect(r.urls).toEqual(['http://svc:1/v1/runs/r1/events'])
  const help = await run(['log', 'verify', '--help'], {})
  expect(help.code).toBe(0)
  expect(help.out[0]).toContain('Usage')
})
