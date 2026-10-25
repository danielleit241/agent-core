import { startStack } from '../e2e/support/harness'
import { registerShop } from '../e2e/support/setup'

// Uses the same OpenAI-compatible endpoint as the service (LLM_BASE_URL, LLM_API_KEY).
const baseUrl = process.env.LLM_BASE_URL
const apiKey = process.env.LLM_API_KEY
const model = process.env.SMOKE_MODEL || process.env.LLM_MODEL_DEFAULT
if (!baseUrl || !apiKey || !model) {
  console.log('SMOKE SKIPPED: set LLM_BASE_URL, LLM_API_KEY and SMOKE_MODEL (or LLM_MODEL_DEFAULT)')
  process.exit(0)
}

const TOTAL_WAIT_MS = 60_000
const FETCH_TIMEOUT_MS = 40_000 // above the server-side wait of 30 s

type Ev = { type: string; payload: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any -- ad hoc event inspection

async function main(): Promise<boolean> {
  const s = await startStack([], { realLlm: { baseUrl: baseUrl!, apiKey: apiKey!, model: model! } })
  try {
    await registerShop(s)
    await s.api('POST', '/v1/agents', {
      id: 'retail-support',
      instructions: 'Bạn là trợ lý của Cửa hàng Mộc. Dùng công cụ để tra cứu đơn hàng.',
      connections: ['shop'],
      autonomy: 'supervised',
      allow: [],
    })
    const started = Date.now()
    let run = await s.api(
      'POST',
      '/v1/runs?wait=30',
      {
        agent: 'retail-support',
        input: { text: 'Đơn 1042 của tôi tới đâu rồi?' },
        principal: { id: 'cus_2291', roles: ['customer'] },
      },
      FETCH_TIMEOUT_MS,
    )
    const runId: string = run.body.id
    // The server holds a wait for 30 s at most, so poll until the 60 s total runs out.
    while ((run.body.status === 'queued' || run.body.status === 'running') && Date.now() - started < TOTAL_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 2000))
      run = await s.api('GET', `/v1/runs/${runId}`, undefined, FETCH_TIMEOUT_MS)
    }
    const events: Ev[] = (await s.api('GET', `/v1/runs/${runId}/events`, undefined, FETCH_TIMEOUT_MS)).body.events
    const usages = events.filter((e) => e.type === 'llm.responded').map((e) => e.payload.usage as Record<string, number>)
    const sum = (k: string): number => usages.reduce((a, u) => a + (u[k] ?? 0), 0)
    const costs = usages.map((u) => u.costUsd).filter((c): c is number => typeof c === 'number')
    const cost = costs.length > 0 ? String(costs.reduce((a, b) => a + b, 0)) : 'n/a'
    const calledOrdersGet = events.some((e) => e.type === 'tool.requested' && e.payload.tool === 'orders.get')
    const output: unknown = run.body.output
    const ok = run.body.status === 'completed' && calledOrdersGet && typeof output === 'string' && output !== ''
    console.log(`model=${model} status=${run.body.status} orders.get=${calledOrdersGet}`)
    console.log(`tokens: input=${sum('inputTokens')} output=${sum('outputTokens')} cost=${cost}`)
    console.log(`run_id=${runId}`)
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
    return ok
  } finally {
    await s.close()
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err: unknown) => {
    console.error('SMOKE FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
