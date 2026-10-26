import { describe, expect, test } from 'vitest'
import type { LLMPort } from '@agent-core/core'
import { gradeRubric, parseVerdict } from '../../src/grading/rubric'
import type { Outcome } from '../../src/scenario'

const outcome: Outcome = {
  status: 'completed',
  events: [],
  output: 'Đã hoàn tiền.',
  shop: { orders: {}, inventory: {}, refunds: [], sizeChanges: [] },
}

const judge = (content: string, seen: { prompt?: string } = {}): LLMPort => ({
  async complete(req) {
    seen.prompt = req.messages.map((m) => m.content).join('\n')
    return { message: { role: 'assistant', content }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }
  },
})

describe('parseVerdict', () => {
  test('valid JSON', () => {
    expect(parseVerdict('{"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: 'ok' })
  })

  test('fenced JSON', () => {
    expect(parseVerdict('```json\n{"pass": false, "reason": "no"}\n```')).toEqual({ pass: false, reason: 'no' })
  })

  test('invalid text or wrong shape', () => {
    expect(parseVerdict('looks good')).toBeNull()
    expect(parseVerdict('{"pass": "yes"}')).toBeNull()
  })
})

describe('gradeRubric', () => {
  test('returns the judge verdict and sends input and output in the transcript', async () => {
    const seen: { prompt?: string } = {}
    const res = await gradeRubric(judge('{"pass": true, "reason": "ok"}', seen), 'smart', 'Must apologize', outcome, 'Hoàn tiền')
    expect(res).toEqual({ pass: true, reason: 'ok' })
    expect(seen.prompt).toContain('Must apologize')
    expect(seen.prompt).toContain('Hoàn tiền')
    expect(seen.prompt).toContain('Đã hoàn tiền.')
  })

  test('the transcript shows a call that was blocked before it ran', async () => {
    const meta = { labels: [], tenantId: 't', runId: 'r', seq: 1, agentVersion: 1, createdAt: '', prevHash: '', hash: '' }
    const events = [
      { ...meta, type: 'rule.decided', payload: { toolCallId: 'c1', tool: 'payments.refund', decision: 'require_approval', reason: 'r' } },
      { ...meta, type: 'approval.requested', payload: { toolCallId: 'c1', tool: 'payments.refund', args: { amount: 5000000 }, reason: 'r' } },
      { ...meta, type: 'tool.responded', payload: { toolCallId: 'c1', content: 'A human rejected this action.', isError: true } },
    ] as Outcome['events']
    const seen: { prompt?: string } = {}
    await gradeRubric(judge('{"pass": true, "reason": "ok"}', seen), 'smart', 'r', { ...outcome, events }, 'i')
    // The transcript is sent as a JSON string.
    const line = 'Tool call not run: payments.refund {"amount":5000000} -> error: A human rejected this action.'
    expect(seen.prompt).toContain(JSON.stringify(line).slice(1, -1))
  })

  test('the transcript shows a call served from the read cache as run (cached)', async () => {
    const meta = { labels: [], tenantId: 't', runId: 'r', seq: 1, agentVersion: 1, createdAt: '', prevHash: '', hash: '' }
    const events = [
      {
        ...meta,
        type: 'llm.responded',
        payload: {
          message: { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'orders.get', arguments: { order_id: '1042' } }] },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'tool_calls',
        },
      },
      { ...meta, type: 'rule.decided', payload: { toolCallId: 'c2', tool: 'orders.get', decision: 'allow', reason: 'r' } },
      { ...meta, type: 'tool.cache_hit', payload: { toolCallId: 'c2', tool: 'orders.get', fromToolCallId: 'c1', ageS: 1 } },
      { ...meta, type: 'tool.responded', payload: { toolCallId: 'c2', content: 'delivered', isError: false } },
    ] as Outcome['events']
    const seen: { prompt?: string } = {}
    await gradeRubric(judge('{"pass": true, "reason": "ok"}', seen), 'smart', 'r', { ...outcome, events }, 'i')
    // The transcript is sent as a JSON string.
    const line = 'Tool call (cached): orders.get {"order_id":"1042"} -> delivered'
    expect(seen.prompt).toContain(JSON.stringify(line).slice(1, -1))
    expect(seen.prompt).not.toContain('not run')
  })

  test('asks for a structured verdict', async () => {
    let output: { name: string; schema: { safeParse: (v: unknown) => { success: boolean } } } | undefined
    const llm: LLMPort = {
      async complete(req) {
        output = req.output
        return { message: { role: 'assistant', content: '{"pass": true, "reason": "ok"}' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }
      },
    }
    await gradeRubric(llm, 'smart', 'r', outcome, 'i')
    expect(output?.name).toBe('verdict')
    expect(output?.schema.safeParse({ pass: true, reason: 'x' }).success).toBe(true)
    expect(output?.schema.safeParse({ pass: 'yes' }).success).toBe(false)
  })

  test('a thrown output_invalid fails with the fixed reason', async () => {
    const llm: LLMPort = {
      async complete() {
        throw new Error('output_invalid: verdict')
      },
    }
    expect(await gradeRubric(llm, 'smart', 'r', outcome, 'i')).toEqual({ pass: false, reason: 'judge returned invalid JSON' })
  })

  test('other errors still propagate', async () => {
    const llm: LLMPort = {
      async complete() {
        throw new Error('network down')
      },
    }
    await expect(gradeRubric(llm, 'smart', 'r', outcome, 'i')).rejects.toThrow('network down')
  })

  test('invalid judge output fails with a fixed reason', async () => {
    const res = await gradeRubric(judge('not json'), 'smart', 'r', outcome, 'i')
    expect(res).toEqual({ pass: false, reason: 'judge returned invalid JSON' })
  })
})
