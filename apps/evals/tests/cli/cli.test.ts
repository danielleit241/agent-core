import { describe, expect, test } from 'vitest'
import { combineRuns, compareBaseline, finishedIds, mergeBaseline, parseCliArgs } from '../../src/cli/cli'
import type { Result } from '../../src/scenario'

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
    expect(compareBaseline({ a: 'pass', b: 'pass' }, [result('a', 'fail'), result('b', 'error')])).toEqual(['a', 'b'])
  })

  test('a scenario missing from the baseline is not a regression', () => {
    expect(compareBaseline({}, [result('new', 'fail')])).toEqual([])
  })

  test('fail to pass is not a regression', () => {
    expect(compareBaseline({ a: 'fail' }, [result('a', 'pass')])).toEqual([])
  })

  test('a scenario that is not run is not a regression', () => {
    expect(compareBaseline({ a: 'pass' }, [])).toEqual([])
  })
})

describe('combineRuns', () => {
  const run = (verdict: Result['verdict'], failures: string[] = [], tokens = 1): Result => ({
    id: 'a',
    group: 'g',
    verdict,
    failures,
    usage: { inputTokens: tokens, outputTokens: tokens },
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

  test('sums usage and time', () => {
    expect(combineRuns([run('pass', [], 2), run('pass', [], 3)])).toMatchObject({ usage: { inputTokens: 5, outputTokens: 5 }, ms: 20 })
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
    expect(mergeBaseline({ a: 'pass', b: 'pass', c: 'pass' }, [result('a', 'error'), result('b', 'fail')])).toEqual({
      a: 'pass',
      b: 'fail',
      c: 'pass',
    })
  })
})
