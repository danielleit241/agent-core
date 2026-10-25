import { GENESIS_HASH, canonicalJson, hashEvent, verifyChain } from '../../src/events/hash'
import type { StoredEvent } from '../../src/types'

function buildChain(n: number): StoredEvent[] {
  const chain: StoredEvent[] = []
  let prevHash = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const base = {
      tenantId: 'default',
      runId: 'r1',
      seq: i,
      type: 'llm.requested' as const,
      payload: { model: 'm' },
      labels: [],
      agentVersion: 1,
      createdAt: `2026-01-01T00:00:0${i}.000Z`,
      prevHash,
    }
    const hash = hashEvent(base)
    chain.push({ ...base, hash })
    prevHash = hash
  }
  return chain
}

describe('hash chain', () => {
  test('canonicalJson sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
  test('verifyChain accepts an intact chain', () => {
    expect(verifyChain(buildChain(3))).toEqual({ valid: true })
  })
  test('verifyChain detects an edited payload', () => {
    const chain = buildChain(3)
    chain[1] = { ...chain[1], payload: { model: 'tampered' } } as StoredEvent
    expect(verifyChain(chain)).toEqual({ valid: false, brokenAtSeq: 2 })
  })
  test('verifyChain detects a deleted event', () => {
    const chain = buildChain(3)
    expect(verifyChain([chain[0], chain[2]])).toEqual({ valid: false, brokenAtSeq: 3 })
  })
})
