import { describe, expect, test } from 'vitest'
import { combineRuns, compareBaseline, finishedIds, mergeBaseline, parseCliArgs } from '../../src/cli/cli'
import type { Result } from '../../src/scenario'

const entry = (verdict: 'pass' | 'fail') => ({ verdict, inputTokens: 1, outputTokens: 1, peakInputTokens: 1, llmTurns: 1, toolCalls: 1 })
const result = (id: string, verdict: Result['verdict']): Result => ({ id, group: 'g', verdict, failures: [] })

describe('parseCliArgs', () => {
  test('defaults to replay with no filters', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'replay', group: undefined, scenario: undefined, writeBaseline: false, help: false, repeat: 1 })
  })

  test('reads every flag', () => {
    expect(parseCliArgs(['--mode', 'record', '--group', 'refund', '--scenario', 'a', '--write-baseline'])).toEqual({
      mode: 'record',
      group: 'refund',
      scenario: 'a',
      writeBaseline: true,
      help: false,
      repeat: 1,
    })
  })

  test('--repeat runs a live scenario several times', () => {
    expect(parseCliArgs(['--mode', 'live', '--repeat', '5']).repeat).toBe(5)
  })

  test.each([['0'], ['21'], ['2.5'], ['x']])('--repeat %s is refused', (n) => {
    expect(() => parseCliArgs(['--mode', 'live', '--repeat', n])).toThrow(/--repeat/)
  })

  test('--repeat above 1 needs --mode live: replay is deterministic and record keeps one answer', () => {
    expect(() => parseCliArgs(['--repeat', '3'])).toThrow(/--mode live/)
    expect(() => parseCliArgs(['--mode', 'record', '--repeat', '3'])).toThrow(/--mode live/)
  })

  test('--help and -h set help', () => {
    expect(parseCliArgs(['--help']).help).toBe(true)
    expect(parseCliArgs(['-h']).help).toBe(true)
  })

  test('an unknown flag throws', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow()
  })

  test('an unknown mode throws', () => {
    expect(() => parseCliArgs(['--mode', 'fast'])).toThrow(/mode/)
  })
})

describe('compareBaseline', () => {
  test('lists a scenario that passed before and does not pass now', () => {
    expect(compareBaseline({ a: entry('pass'), b: entry('pass') }, [result('a', 'fail'), result('b', 'error')])).toEqual(['a', 'b'])
  })

  test('a scenario missing from the baseline is not a regression', () => {
    expect(compareBaseline({}, [result('new', 'fail')])).toEqual([])
  })

  test('fail to pass is not a regression', () => {
    expect(compareBaseline({ a: entry('fail') }, [result('a', 'pass')])).toEqual([])
  })

  test('a scenario that is not run is not a regression', () => {
    expect(compareBaseline({ a: entry('pass') }, [])).toEqual([])
  })
})

describe('combineRuns', () => {
  const run = (verdict: Result['verdict'], failures: string[] = [], tokens = 1): Result => ({
    id: 'a',
    group: 'g',
    verdict,
    failures,
    metrics: { inputTokens: tokens, outputTokens: tokens, peakInputTokens: tokens, llmTurns: 1, toolCalls: 1 },
    ms: 10,
  })

  test('passes only when every run passes, and carries the rate', () => {
    expect(combineRuns([run('pass'), run('pass')])).toMatchObject({ verdict: 'pass', runs: { passed: 2, total: 2 }, failures: [] })
  })

  test('one failing run fails the scenario and keeps its first reason', () => {
    expect(combineRuns([run('pass'), run('fail', ['state.refunds: x']), run('pass')])).toMatchObject({
      verdict: 'fail',
      runs: { passed: 2, total: 3 },
      failures: ['state.refunds: x'],
    })
  })

  test('an error wins over a fail', () => {
    expect(combineRuns([run('fail', ['f']), run('error', ['timeout'])]).verdict).toBe('error')
  })

  test('metrics are the rounded mean over the runs; time is summed', () => {
    expect(combineRuns([run('pass', [], 2), run('pass', [], 3)])).toMatchObject({
      metrics: { inputTokens: 3, outputTokens: 3, peakInputTokens: 3, llmTurns: 1, toolCalls: 1 },
      ms: 20,
    })
  })

  test('the mean cost is kept only when every run has one', () => {
    const withCost = (c: number): Result => ({ ...run('pass'), metrics: { ...run('pass').metrics!, costUsd: c } })
    expect(combineRuns([withCost(0.1), withCost(0.3)]).metrics?.costUsd).toBeCloseTo(0.2)
    expect(combineRuns([withCost(0.1), run('pass')]).metrics).not.toHaveProperty('costUsd')
  })

  test('a single run is returned as is', () => {
    const one = run('fail', ['f'])
    expect(combineRuns([one])).toBe(one)
  })
})

describe('finishedIds', () => {
  test('keeps only scenarios that were graded: an error or a skipped scenario keeps its old recording', () => {
    expect(finishedIds([result('a', 'pass'), result('b', 'fail'), result('c', 'error')])).toEqual(['a', 'b'])
  })
})

describe('mergeBaseline', () => {
  test('an error does not overwrite the baseline, and skipped scenarios keep theirs', () => {
    const merged = mergeBaseline({ a: entry('pass'), b: entry('pass'), c: entry('pass') }, [result('a', 'error'), result('b', 'fail')])
    expect(merged.a).toEqual(entry('pass'))
    expect(merged.b?.verdict).toBe('fail')
    expect(merged.c).toEqual(entry('pass'))
  })

  test('writes the verdict with the full metrics', () => {
    const metrics = { inputTokens: 9, outputTokens: 8, peakInputTokens: 7, llmTurns: 2, toolCalls: 1, costUsd: 0.5 }
    expect(mergeBaseline({}, [{ ...result('a', 'pass'), metrics }])).toEqual({ a: { verdict: 'pass', ...metrics } })
  })
})
