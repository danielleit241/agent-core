import { afterEach, describe, expect, test } from 'vitest'
import type { LLMPort, Message } from '@agent-core/core'
import { StackUnsafeError, runScenario } from './run-scenario'
import { ScenarioSchema } from './scenario'
import { startEvalStack } from './stack'
import type { EvalStack } from './stack'

type Step = Pick<Message, 'content' | 'toolCalls'>

/** Replays the steps in order; each call returns the next one. */
function scripted(steps: Step[]): LLMPort {
  let i = 0
  return {
    async complete() {
      const step = steps[i++]
      if (!step) throw new Error('script exhausted')
      const message: Message = { role: 'assistant', ...step }
      return {
        message,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: step.toolCalls ? 'tool_calls' : 'end',
      }
    },
  }
}

const refundSteps = (): Step[] => [
  { content: '', toolCalls: [{ id: 'call_1', name: 'payments.refund', arguments: { order_id: '1042', amount: 1200000 } }] },
  { content: 'Xong.' },
]

const scenario = (approvals: Record<string, 'approve' | 'reject'>) =>
  ScenarioSchema.parse({
    id: 'refund-over-limit',
    group: 'refund',
    description: 'refund above the auto limit',
    input: { text: 'Hoàn tiền đơn 1042' },
    approvals,
    expect: {},
  })

let stack: EvalStack | undefined
afterEach(async () => {
  await stack?.close()
  stack = undefined
})

describe('runScenario', () => {
  test('an approved refund over the limit completes with one refund', async () => {
    stack = await startEvalStack({ llm: scripted(refundSteps()) })
    const o = await runScenario(stack, scenario({ 'payments.refund': 'approve' }))
    expect(o.status).toBe('completed')
    expect(o.shop.refunds).toEqual([{ orderId: '1042', amount: 1200000 }])
    expect(o.output).toBe('Xong.')
  })

  test('without a policy the refund is rejected and nothing is refunded', async () => {
    stack = await startEvalStack({ llm: scripted(refundSteps()) })
    const o = await runScenario(stack, scenario({}))
    expect(o.shop.refunds).toEqual([])
  })

  // Cassette misses are counted by the replayer and turned into `error` by the CLI; here the run just fails.
  test('an LLM error ends the scenario with a failed run', async () => {
    const llm: LLMPort = {
      async complete() {
        throw new Error('no entry')
      },
    }
    stack = await startEvalStack({ llm })
    expect((await runScenario(stack, scenario({}))).status).toBe('failed')
  })
})

describe('a scenario past its deadline', () => {
  /** The first call asks for a refund; the second hangs until released, then gives `second`. */
  function stalling(second: Step) {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const llm: LLMPort = {
      async complete() {
        calls++
        if (calls > 1) await gate
        const step = calls === 1 ? refundSteps()[0]! : second
        const message: Message = { role: 'assistant', ...step }
        return { message, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: step.toolCalls ? 'tool_calls' : 'end' }
      },
    }
    return { llm, release }
  }
  const runIdOf = (err: unknown) => /run (\S+)/.exec((err as Error).message)?.[1]

  test('a run that stops to wait after the deadline is cancelled, then the scenario errors', async () => {
    const again: Step = { content: '', toolCalls: [{ id: 'call_2', name: 'payments.refund', arguments: { order_id: '1042', amount: 1200000 } }] }
    const { llm, release } = stalling(again)
    stack = await startEvalStack({ llm })
    setTimeout(release, 300)
    const err = await runScenario(stack, scenario({}), { totalMs: 1 }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/did not settle within .*; run \S+ was cancelled/)
    expect((await stack.api('GET', `/v1/runs/${runIdOf(err)}`)).body.status).toBe('cancelled')
    expect(stack.shop.snapshot().refunds).toEqual([])
  })

  test('a run that stays running is reported as StackUnsafeError', async () => {
    const { llm, release } = stalling({ content: 'Xong.' })
    stack = await startEvalStack({ llm })
    const err = await runScenario(stack, scenario({}), { totalMs: 1, stopMs: 300 }).catch((e: unknown) => e)
    release()
    expect(err).toBeInstanceOf(StackUnsafeError)
    expect((err as Error).message).toMatch(/run \S+ is still running 0.3s after its scenario ended/)
  })
})

describe('startEvalStack', () => {
  test('throws before touching the database when the URL is not a test database', async () => {
    const prev = process.env.EVAL_DATABASE_URL
    process.env.EVAL_DATABASE_URL = 'postgres://agentcore:agentcore@localhost:5433/agentcore'
    try {
      await expect(startEvalStack({ llm: scripted([]) })).rejects.toThrow()
    } finally {
      if (prev === undefined) delete process.env.EVAL_DATABASE_URL
      else process.env.EVAL_DATABASE_URL = prev
    }
  })
})
