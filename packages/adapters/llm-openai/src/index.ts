import { randomUUID } from 'node:crypto'
import type { LLMPort, Message, ToolCall, ToolDescriptor, Usage } from '@agent-core/core'
import { fromWireName, toWireName } from './wire'

export { fromWireName, toWireName }

export class LlmError extends Error {
  readonly status: number
  readonly retryable: boolean
  constructor(message: string, status: number, retryable: boolean) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.retryable = retryable
  }
}

type Opts = {
  baseUrl: string
  apiKey: string
  models: Record<string, string>
  fetch?: typeof fetch
  retryDelaysMs?: number[]
}

const REQUEST_TIMEOUT_MS = 60_000
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function toWireMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: toWireName(tc.name), arguments: JSON.stringify(tc.arguments) },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

function toWireTool(t: ToolDescriptor): Record<string, unknown> {
  return { type: 'function', function: { name: toWireName(t.name), description: t.description, parameters: t.inputSchema } }
}

function parseArguments(raw: unknown): { arguments: Record<string, unknown>; argumentsError?: string } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { arguments: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : '')
  } catch {
    return { arguments: {}, argumentsError: 'Tool arguments are not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { arguments: {}, argumentsError: 'Tool arguments are valid JSON but not a JSON object' }
  }
  return { arguments: parsed as Record<string, unknown> }
}

function providerMessage(body: unknown): string | undefined {
  const msg = (body as { error?: { message?: unknown } } | null | undefined)?.error?.message
  return typeof msg === 'string' ? msg : undefined
}

type WireResponse = {
  choices?: {
    message?: {
      content?: string | { type?: string; text?: string }[] | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]
    }
    finish_reason?: string
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
}

export function createOpenAICompatible(opts: Opts): LLMPort {
  const doFetch = opts.fetch ?? fetch
  const delays = opts.retryDelaysMs ?? [500, 1000]
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`

  async function post(body: unknown): Promise<WireResponse> {
    let last: LlmError | undefined
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1])
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (e) {
        last = new LlmError(`LLM request failed: ${e instanceof Error ? e.message : String(e)}`, 0, true)
        continue
      }
      const json: unknown = await res.json().catch(() => undefined)
      if (res.ok) return (json ?? {}) as WireResponse
      const detail = providerMessage(json)
      const message = `LLM provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`
      if (res.status === 429 || res.status >= 500) {
        last = new LlmError(message, res.status, true)
        continue
      }
      throw new LlmError(message, res.status, false)
    }
    throw last ?? new LlmError('LLM request failed', 0, true)
  }

  return {
    async complete(req) {
      const model = opts.models[req.model]
      if (model === undefined) throw new Error(`unknown_model_alias: ${req.model}`)
      const wireToInternal = new Map<string, string>()
      for (const t of req.tools) {
        const wire = toWireName(t.name)
        const other = wireToInternal.get(wire)
        if (other !== undefined) throw new Error(`tool_name_collision: ${other}, ${t.name}`)
        wireToInternal.set(wire, t.name)
      }
      const json = await post({
        model,
        messages: req.messages.map(toWireMessage),
        ...(req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
      })
      const choice = json.choices?.[0]
      if (!choice?.message) throw new LlmError('LLM response has no choices', 200, false)

      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
        const wire = tc.function?.name
        if (!tc.id || !wire) throw new LlmError('LLM response has a tool call without id or function name', 200, false)
        // The provider id is only checked for presence; ids are ours, so provider reuse or odd values are harmless.
        return { id: `call_${randomUUID()}`, name: wireToInternal.get(wire) ?? fromWireName(wire), ...parseArguments(tc.function?.arguments) }
      })
      const raw = choice.message.content
      const content = Array.isArray(raw)
        ? raw.map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('')
        : (raw ?? '')
      const message: Message = {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
      const usage: Usage = {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        ...(typeof json.usage?.cost === 'number' ? { costUsd: json.usage.cost } : {}),
      }
      const stopReason =
        toolCalls.length > 0
          ? 'tool_calls'
          : choice.finish_reason === 'length'
            ? 'length'
            : 'end'
      return { message, usage, stopReason }
    },
  }
}
