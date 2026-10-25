import { describe, expect, test } from 'vitest'
import type { LLMPort } from '@agent-core/core'
import { gradeRubric, parseVerdict } from './rubric'
import type { Outcome } from '../scenario'

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
