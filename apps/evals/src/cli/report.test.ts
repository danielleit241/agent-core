import { expect, test } from 'vitest'
import { formatReport } from './report'

test('formats one line per group, a total line and each non-passing id', () => {
  const out = formatReport([
    { id: 'a', group: 'refund', verdict: 'pass', failures: [] },
    { id: 'b', group: 'refund', verdict: 'fail', failures: ['status: expected completed, got failed', 'second'] },
    { id: 'c', group: 'size', verdict: 'pass', failures: [] },
    { id: 'd', group: 'size', verdict: 'error', failures: ['CassetteMissError'] },
    { id: 'e', group: 'size', verdict: 'pass', failures: [] },
  ])
  expect(out.split('\n')).toEqual([
    'refund  1/2  50%',
    'size  2/3  67%',
    'total  3/5  60%',
    'b  fail: status: expected completed, got failed',
    'd  error: CassetteMissError',
  ])
})

test('adds a usage line with tokens, cost and time when results carry usage', () => {
  const out = formatReport([
    { id: 'a', group: 'g', verdict: 'pass', failures: [], usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 }, ms: 1500 },
    { id: 'b', group: 'g', verdict: 'pass', failures: [], usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.0005 }, ms: 500 },
  ])
  expect(out.split('\n').at(-1)).toBe('usage  150 in, 25 out tokens, $0.0015, 2.0s')
})

test('leaves the cost out when any run has no cost', () => {
  const out = formatReport([
    { id: 'a', group: 'g', verdict: 'pass', failures: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 }, ms: 0 },
    { id: 'b', group: 'g', verdict: 'pass', failures: [], usage: { inputTokens: 1, outputTokens: 1 }, ms: 0 },
  ])
  expect(out.split('\n').at(-1)).toBe('usage  2 in, 2 out tokens, 0.0s')
})

test('a scenario run several times shows its pass rate', () => {
  const out = formatReport([
    { id: 'a', group: 'g', verdict: 'fail', failures: ['state.refunds: x'], runs: { passed: 3, total: 4 } },
    { id: 'b', group: 'g', verdict: 'pass', failures: [], runs: { passed: 4, total: 4 } },
  ])
  expect(out.split('\n')).toEqual(['g  1/2  50%', 'total  1/2  50%', 'a  fail (3/4 runs passed): state.refunds: x'])
})
