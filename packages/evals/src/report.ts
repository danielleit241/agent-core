import type { Result } from './scenario'

const pct = (passed: number, total: number): number => (total === 0 ? 0 : Math.round((passed / total) * 100))

export function formatReport(results: Result[]): string {
  const groups = new Map<string, Result[]>()
  for (const r of results) groups.set(r.group, [...(groups.get(r.group) ?? []), r])
  const lines: string[] = []
  for (const [group, rs] of groups) {
    const passed = rs.filter((r) => r.verdict === 'pass').length
    lines.push(`${group}  ${passed}/${rs.length}  ${pct(passed, rs.length)}%`)
  }
  const passed = results.filter((r) => r.verdict === 'pass').length
  lines.push(`total  ${passed}/${results.length}  ${pct(passed, results.length)}%`)
  const used = results.flatMap((r) => (r.usage ? [r.usage] : []))
  if (used.length > 0) {
    const sum = (f: (u: (typeof used)[number]) => number) => used.reduce((n, u) => n + f(u), 0)
    const cost = used.every((u) => u.costUsd !== undefined) ? `, $${sum((u) => u.costUsd!).toFixed(4)}` : ''
    const secs = (results.reduce((n, r) => n + (r.ms ?? 0), 0) / 1000).toFixed(1)
    lines.push(`usage  ${sum((u) => u.inputTokens)} in, ${sum((u) => u.outputTokens)} out tokens${cost}, ${secs}s`)
  }
  for (const r of results) {
    const rate = r.runs && r.runs.total > 1 ? ` (${r.runs.passed}/${r.runs.total} runs passed)` : ''
    if (r.verdict !== 'pass') lines.push(`${r.id}  ${r.verdict}${rate}: ${r.failures[0] ?? '(no detail)'}`)
  }
  return lines.join('\n')
}
