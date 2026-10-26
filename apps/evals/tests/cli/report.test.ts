import { describe, expect, test } from 'vitest'
import { formatReport, formatSummaryMarkdown, passK } from '../../src/cli/report'
import type { Result } from '../../src/scenario'

const m = (inputTokens: number, extra: object = {}) => ({
  inputTokens,
  outputTokens: 100,
  peakInputTokens: 500,
  llmTurns: 3,
  toolCalls: 2,
  ...extra,
})
const entry = (inputTokens: number) => ({ verdict: 'pass' as const, ...m(inputTokens) })

test('formats one line per group, a total line and each non-passing id', () => {
  const out = formatReport(
    [
      { id: 'a', group: 'refund', verdict: 'pass', failures: [] },
      { id: 'b', group: 'refund', verdict: 'fail', failures: ['status: expected completed, got failed', 'second'] },
      { id: 'c', group: 'size', verdict: 'pass', failures: [] },
      { id: 'd', group: 'size', verdict: 'error', failures: ['CassetteMissError'] },
      { id: 'e', group: 'size', verdict: 'pass', failures: [] },
    ],
    {},
  )
  expect(out.split('\n')).toEqual([
    'refund  1/2  50%',
    'size  2/3  67%',
    'total  3/5  60%',
    'b  fail: status: expected completed, got failed',
    'd  error: CassetteMissError',
  ])
})

test('adds a usage line with tokens, cost and time when results carry metrics', () => {
  const out = formatReport(
    [
      { id: 'a', group: 'g', verdict: 'pass', failures: [], metrics: m(100, { outputTokens: 20, costUsd: 0.001 }), ms: 1500 },
      { id: 'b', group: 'g', verdict: 'pass', failures: [], metrics: m(50, { outputTokens: 5, costUsd: 0.0005 }), ms: 500 },
    ],
    {},
  )
  expect(out.split('\n').at(-1)).toBe('usage  150 in, 25 out tokens, $0.0015, 2.0s')
})

test('leaves the cost out when any run has no cost', () => {
  const out = formatReport(
    [
      { id: 'a', group: 'g', verdict: 'pass', failures: [], metrics: m(1, { outputTokens: 1, costUsd: 0.1 }), ms: 0 },
      { id: 'b', group: 'g', verdict: 'pass', failures: [], metrics: m(1, { outputTokens: 1 }), ms: 0 },
    ],
    {},
  )
  expect(out.split('\n').at(-1)).toBe('usage  2 in, 2 out tokens, 0.0s')
})

test('a scenario run several times shows its pass rate', () => {
  const out = formatReport(
    [
      { id: 'a', group: 'g', verdict: 'fail', failures: ['state.refunds: x'], runs: { passed: 3, total: 4 } },
      { id: 'b', group: 'g', verdict: 'pass', failures: [], runs: { passed: 4, total: 4 } },
    ],
    {},
  )
  expect(out.split('\n')).toEqual([
    'g  1/2  50%',
    'total  1/2  50%',
    'pass@1  88%   pass^4  50%',
    'a  fail (3/4 runs passed): state.refunds: x',
  ])
})

const withMetrics = (id: string, inputTokens: number): Result => ({ id, group: 'g', verdict: 'pass', failures: [], metrics: m(inputTokens) })

test('a scenario line shows each metric and its change against the baseline', () => {
  const lines = formatReport([withMetrics('a', 960)], { a: entry(1000) }).split('\n')
  expect(lines).toContain('a  pass  in 960 (−4.0%)  out 100 (=)  peak 500 (=)  turns 3 (=)  tools 2 (=)')
})

test('a rise shows a plus sign and thousands separators', () => {
  const lines = formatReport([withMetrics('a', 10250)], { a: entry(10000) }).split('\n')
  expect(lines.some((l) => l.includes('in 10,250 (+2.5%)'))).toBe(true)
})

test('a scenario without a baseline entry shows the numbers alone', () => {
  const lines = formatReport([withMetrics('a', 1200)], {}).split('\n')
  expect(lines).toContain('a  pass  in 1,200  out 100  peak 500  turns 3  tools 2')
})

test('the sum line adds the metrics, takes the largest peak and shows its change', () => {
  const lines = formatReport([withMetrics('a', 960), withMetrics('b', 1040)], { a: entry(1000), b: entry(1000) }).split('\n')
  expect(lines).toContain('sum  in 2,000 (=)  out 200 (=)  peak 500 (=)  turns 6 (=)  tools 4 (=)')
})

test('a metric change never adds a failure line', () => {
  const out = formatReport([withMetrics('a', 5000)], { a: entry(1000) })
  expect(out).not.toMatch(/fail|error/)
})

describe('passK', () => {
  const runs = (id: string, passed: number): Result => ({
    id,
    group: 'g',
    verdict: passed === 3 ? 'pass' : 'fail',
    failures: [],
    runs: { passed, total: 3 },
  })

  test('mean pass rate and the share of scenarios whose runs all passed', () => {
    const k = passK([runs('a', 3), runs('b', 2), runs('c', 0)])!
    expect(k.passAt1).toBeCloseTo(0.556, 3)
    expect(k.passHatK).toBeCloseTo(0.333, 3)
  })

  test('the report prints both', () => {
    expect(formatReport([runs('a', 3), runs('b', 2), runs('c', 0)], {}).split('\n')).toContain('pass@1  56%   pass^3  33%')
  })

  test('is null when nothing ran more than once', () => {
    expect(passK([{ id: 'a', group: 'g', verdict: 'pass', failures: [] }])).toBeNull()
  })
})

test('the Markdown summary is a table with the same figures', () => {
  const md = formatSummaryMarkdown([withMetrics('a', 960)], { a: entry(1000) })
  expect(md).toContain('| a | pass | 960 (−4.0%) | 100 (=) | 500 (=) | 3 (=) | 2 (=) |')
})
