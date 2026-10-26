const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** In-process counters. Labels are fixed small sets, so no tenant, run, agent or path can leak into them. */
class Metrics {
  private http = new Map<string, number>()
  private llm = { ok: 0, error: 0 }
  private tokens = { input: 0, output: 0 }

  httpRequest(method: string, statusCode: number): void {
    const key = `${METHODS.has(method) ? method : 'OTHER'}|${Math.floor(statusCode / 100)}xx`
    this.http.set(key, (this.http.get(key) ?? 0) + 1)
  }

  llmCall(outcome: 'ok' | 'error', usage?: { input: number; output: number }): void {
    this.llm[outcome]++
    if (usage) {
      this.tokens.input += usage.input
      this.tokens.output += usage.output
    }
  }

  /** The counters in Prometheus text format. */
  render(): string {
    const lines = ['# TYPE agent_core_http_requests_total counter']
    for (const [key, n] of [...this.http].sort()) {
      const [method, cls] = key.split('|')
      lines.push(`agent_core_http_requests_total{method="${method}",status_class="${cls}"} ${n}`)
    }
    lines.push('# TYPE agent_core_llm_calls_total counter')
    lines.push(`agent_core_llm_calls_total{outcome="ok"} ${this.llm.ok}`)
    lines.push(`agent_core_llm_calls_total{outcome="error"} ${this.llm.error}`)
    lines.push('# TYPE agent_core_llm_tokens_total counter')
    lines.push(`agent_core_llm_tokens_total{kind="input"} ${this.tokens.input}`)
    lines.push(`agent_core_llm_tokens_total{kind="output"} ${this.tokens.output}`)
    return lines.join('\n') + '\n'
  }
}

export const metrics = new Metrics()
