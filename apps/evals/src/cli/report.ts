import type { Metrics } from '../grading/metrics'
import type { Result } from '../scenario'

export type BaselineEntry = { verdict: 'pass' | 'fail' } & Metrics
export type Baseline = Record<string, BaselineEntry>

const pct = (passed: number, total: number): number => (total === 0 ? 0 : Math.round((passed / total) * 100))
const num = (n: number): string => n.toLocaleString('en-US')

/** `(−4.0%)`, `(+2.5%)` or `(=)`; empty when the baseline is 0 and the value is not. */
function change(now: number, was: number | undefined): string {
  if (was === undefined) return ''
  if (now === was) return '(=)'
  if (was === 0) return ''
  const d = ((now - was) / was) * 100
  return `(${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}%)`
}

type Field = { label: string; key: 'inputTokens' | 'outputTokens' | 'peakInputTokens' | 'llmTurns' | 'toolCalls'; head: string }
const FIELDS: Field[] = [
  { label: 'in', key: 'inputTokens', head: 'Input' },
  { label: 'out', key: 'outputTokens', head: 'Output' },
  { label: 'peak', key: 'peakInputTokens', head: 'Peak' },
  { label: 'turns', key: 'llmTurns', head: 'Turns' },
  { label: 'tools', key: 'toolCalls', head: 'Tools' },
]

/** Sums the metrics; the peak is the largest peak, because a sum of peaks means nothing. */
function sumMetrics(ms: Metrics[]): Metrics {
  const sum = (f: (m: Metrics) => number) => ms.reduce((n, m) => n + f(m), 0)
  const out: Metrics = {
    inputTokens: sum((m) => m.inputTokens),
    outputTokens: sum((m) => m.outputTokens),
    peakInputTokens: Math.max(0, ...ms.map((m) => m.peakInputTokens)),
    llmTurns: sum((m) => m.llmTurns),
    toolCalls: sum((m) => m.toolCalls),
  }
  return ms.every((m) => m.costUsd !== undefined) ? { ...out, costUsd: sum((m) => m.costUsd!) } : out
}

/** Mean pass rate and the share of scenarios whose runs all passed; null when nothing ran more than once. */
export function passK(results: Result[]): { passAt1: number; passHatK: number } | null {
  if (!results.some((r) => (r.runs?.total ?? 1) > 1)) return null
  const rates = results.map((r) => (r.runs ? r.runs.passed / r.runs.total : r.verdict === 'pass' ? 1 : 0))
  const allPassed = results.filter((r) => (r.runs ? r.runs.passed === r.runs.total : r.verdict === 'pass')).length
  return { passAt1: rates.reduce((n, x) => n + x, 0) / results.length, passHatK: allPassed / results.length }
}

/** Figures with their change against the baseline entry (if any). */
function cells(m: Metrics, was: Metrics | undefined): string[] {
  return FIELDS.map((f) => [num(m[f.key]), change(m[f.key], was?.[f.key])].filter(Boolean).join(' '))
}

/** The baseline total covers the same scenarios as the results, and exists only when all of them have an entry. */
function baselineSum(withMetrics: Result[], baseline: Baseline): Metrics | undefined {
  const entries = withMetrics.map((r) => baseline[r.id])
  return entries.every((e) => e !== undefined) ? sumMetrics(entries as BaselineEntry[]) : undefined
}

export function formatReport(results: Result[], baseline: Baseline): string {
  const groups = new Map<string, Result[]>()
  for (const r of results) groups.set(r.group, [...(groups.get(r.group) ?? []), r])
  const lines: string[] = []
  for (const [group, rs] of groups) {
    const passed = rs.filter((r) => r.verdict === 'pass').length
    lines.push(`${group}  ${passed}/${rs.length}  ${pct(passed, rs.length)}%`)
  }
  const passed = results.filter((r) => r.verdict === 'pass').length
  lines.push(`total  ${passed}/${results.length}  ${pct(passed, results.length)}%`)
  const k = passK(results)
  if (k) {
    const n = Math.max(...results.map((r) => r.runs?.total ?? 1))
    lines.push(`pass@1  ${Math.round(k.passAt1 * 100)}%   pass^${n}  ${Math.round(k.passHatK * 100)}%`)
  }
  const measured = results.flatMap((r) => (r.metrics ? [{ r, m: r.metrics }] : []))
  const labelled = (cs: string[]) => FIELDS.map((f, i) => `${f.label} ${cs[i]}`).join('  ')
  for (const { r, m } of measured) lines.push(`${r.id}  ${r.verdict}  ${labelled(cells(m, baseline[r.id]))}`)
  if (measured.length > 0) {
    const total = sumMetrics(measured.map((x) => x.m))
    lines.push(`sum  ${labelled(cells(total, baselineSum(measured.map((x) => x.r), baseline)))}`)
    const cost = total.costUsd !== undefined ? `, $${total.costUsd.toFixed(4)}` : ''
    const secs = (results.reduce((n, r) => n + (r.ms ?? 0), 0) / 1000).toFixed(1)
    lines.push(`usage  ${total.inputTokens} in, ${total.outputTokens} out tokens${cost}, ${secs}s`)
  }
  for (const r of results) {
    const rate = r.runs && r.runs.total > 1 ? ` (${r.runs.passed}/${r.runs.total} runs passed)` : ''
    if (r.verdict !== 'pass') lines.push(`${r.id}  ${r.verdict}${rate}: ${r.failures[0] ?? '(no detail)'}`)
  }
  return lines.join('\n')
}

/** The same figures as a Markdown table, for the CI step summary. */
export function formatSummaryMarkdown(results: Result[], baseline: Baseline): string {
  const measured = results.flatMap((r) => (r.metrics ? [{ r, m: r.metrics }] : []))
  const row = (cols: string[]) => `| ${cols.join(' | ')} |`
  const lines = [row(['Scenario', 'Verdict', ...FIELDS.map((f) => f.head)]), row(['---', '---', ...FIELDS.map(() => '---')])]
  for (const { r, m } of measured) lines.push(row([r.id, r.verdict, ...cells(m, baseline[r.id])]))
  if (measured.length > 0) {
    const total = sumMetrics(measured.map((x) => x.m))
    lines.push(row(['sum', '', ...cells(total, baselineSum(measured.map((x) => x.r), baseline))]))
  }
  return `${lines.join('\n')}\n`
}
