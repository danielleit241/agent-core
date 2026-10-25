import { randomUUID } from 'node:crypto'
import { DEFAULT_MODEL_PROFILE } from '@agent-core/core'
import type { LLMPort, Message, ModelProfile, ToolCall, ToolDescriptor, Usage } from '@agent-core/core'
import { z } from 'zod'
import { fromWireName, toWireName } from './wire'

export { fromWireName, toWireName }
export { probeModel } from './probe'

export class LlmError extends Error {
  readonly status: number
  readonly retryable: boolean
  readonly retryAfterMs?: number
  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.retryable = retryable
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

/** The provider's wait hint in ms: `retry-after-ms` wins over `retry-after` (integer seconds or an HTTP date). */
export function parseRetryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const ms = headers.get('retry-after-ms')?.trim()
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms))
  const ra = headers.get('retry-after')?.trim()
  if (!ra) return undefined
  if (/^\d+$/.test(ra)) return Number(ra) * 1000
  const at = Date.parse(ra)
  return Number.isNaN(at) || at <= nowMs ? undefined : at - nowMs
}

type Opts = {
  baseUrl: string
  apiKey: string
  models: Record<string, string>
  fetch?: typeof fetch
  retryDelaysMs?: number[]
  /** Capabilities of a model, keyed by the real model id (not the alias). Default: `DEFAULT_MODEL_PROFILE`. */
  profile?: (model: string) => ModelProfile | Promise<ModelProfile>
}

const OUTPUT_ATTEMPTS = 3

/**
 * True when strict structured output accepts the schema: every object lists all its properties in
 * `required` and is closed. Optional fields fail this; such schemas use validate-and-retry instead.
 */
function strictCompatible(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(strictCompatible)
  if (node === null || typeof node !== 'object') return true
  const n = node as Record<string, unknown>
  if (n.type === 'object' || n.properties !== undefined) {
    const keys = Object.keys((n.properties as Record<string, unknown> | undefined) ?? {})
    const required = new Set(Array.isArray(n.required) ? n.required : [])
    if (n.additionalProperties !== false || !keys.every((k) => required.has(k))) return false
  }
  return Object.values(n).every(strictCompatible)
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

// Some OpenAI-compatible providers keep only the first system message, so adjacent ones are sent as one.
function mergeSystemRuns(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    const last = out.at(-1)
    if (m.role === 'system' && last?.role === 'system') out[out.length - 1] = { role: 'system', content: `${last.content}\n\n${m.content}` }
    else out.push(m)
  }
  return out
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
      } catch {
        // The cause text can carry the URL; errors reach the event log, so only fixed text is kept.
        last = new LlmError('LLM request failed: network error', 0, true)
        continue
      }
      const json: unknown = await res.json().catch(() => undefined)
      if (res.ok) return (json ?? {}) as WireResponse
      // Provider text can echo part of the key (for example on a 401), so only the status is kept.
      const message = `LLM provider returned HTTP ${res.status}`
      if (res.status === 429 || res.status >= 500) {
        // A provider wait hint is longer than the fast retries; the caller schedules the wait.
        const retryAfterMs = parseRetryAfterMs(res.headers, Date.now())
        if (retryAfterMs !== undefined) throw new LlmError(message, res.status, true, retryAfterMs)
        last = new LlmError(message, res.status, true)
        continue
      }
      throw new LlmError(message, res.status, false)
    }
    throw last ?? new LlmError('LLM request failed', 0, true)
  }

  async function once(
    model: string,
    profile: ModelProfile,
    messages: Message[],
    tools: ToolDescriptor[],
    responseFormat?: unknown,
  ): Promise<{ message: Message; usage: Usage; stopReason: 'end' | 'tool_calls' | 'length' }> {
    const wireToInternal = new Map<string, string>()
    for (const t of tools) {
      const wire = toWireName(t.name)
      const other = wireToInternal.get(wire)
      if (other !== undefined) throw new Error(`tool_name_collision: ${other}, ${t.name}`)
      wireToInternal.set(wire, t.name)
    }
    const json = await post({
      model,
      messages: mergeSystemRuns(messages).map(toWireMessage),
      ...(tools.length > 0 ? { tools: tools.map(toWireTool) } : {}),
      ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
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
    const inputTokens = json.usage?.prompt_tokens ?? 0
    const outputTokens = json.usage?.completion_tokens ?? 0
    const costUsd =
      typeof json.usage?.cost === 'number'
        ? json.usage.cost
        : profile.priceInPerMTok !== undefined && profile.priceOutPerMTok !== undefined
          ? (inputTokens * profile.priceInPerMTok + outputTokens * profile.priceOutPerMTok) / 1e6
          : undefined
    const usage: Usage = { inputTokens, outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) }
    const stopReason =
      toolCalls.length > 0
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'length'
          : 'end'
    return { message, usage, stopReason }
  }

  return {
    async complete(req) {
      const model = opts.models[req.model]
      if (model === undefined) throw new Error(`unknown_model_alias: ${req.model}`)
      const profile = await (opts.profile ?? (() => DEFAULT_MODEL_PROFILE))(model)
      if (!req.output) return once(model, profile, req.messages, req.tools)

      const { name, schema } = req.output
      // A reply with tool calls has no JSON content, so the two cannot be combined.
      if (req.tools.length > 0) throw new Error(`output_with_tools_not_supported: ${name}`)
      const jsonSchema = { ...z.toJSONSchema(schema), additionalProperties: false }
      delete (jsonSchema as { $schema?: string }).$schema
      /** The validated value as canonical JSON text, or the first problem found. */
      const check = (content: string): { ok: string } | { issue: string } => {
        // Models often wrap JSON in a Markdown fence; that is not worth a retry.
        const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content.trim())
        let value: unknown
        try {
          value = JSON.parse(fenced ? fenced[1]! : content)
        } catch {
          return { issue: 'not parseable as JSON' }
        }
        const parsed = schema.safeParse(value)
        if (parsed.success) return { ok: JSON.stringify(parsed.data) }
        const first = parsed.error.issues[0]!
        return { issue: `${first.path.length > 0 ? `${first.path.join('.')}: ` : ''}${first.message}` }
      }

      if (profile.jsonSchemaStrict && strictCompatible(jsonSchema)) {
        const res = await once(model, profile, req.messages, req.tools, {
          type: 'json_schema',
          json_schema: { name, strict: true, schema: jsonSchema },
        })
        const r = check(res.message.content)
        if ('issue' in r) throw new LlmError(`output_invalid: ${name}`, 422, false)
        return { ...res, message: { role: 'assistant', content: r.ok } }
      }

      // A user message, not a system one: some providers keep only the first system message.
      const messages: Message[] = [
        ...req.messages,
        { role: 'user', content: `Reply with only a JSON object that matches this JSON Schema: ${JSON.stringify(jsonSchema)}` },
      ]
      let inputTokens = 0
      let outputTokens = 0
      let costUsd: number | undefined
      for (let attempt = 1; attempt <= OUTPUT_ATTEMPTS; attempt++) {
        const res = await once(model, profile, messages, req.tools)
        inputTokens += res.usage.inputTokens
        outputTokens += res.usage.outputTokens
        if (res.usage.costUsd !== undefined) costUsd = (costUsd ?? 0) + res.usage.costUsd
        const usage: Usage = { inputTokens, outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) }
        const r = check(res.message.content)
        if ('ok' in r) return { message: { role: 'assistant', content: r.ok }, usage, stopReason: res.stopReason }
        messages.push(
          { role: 'assistant', content: res.message.content },
          { role: 'user', content: `That reply was not valid JSON for the schema: ${r.issue}. Reply again with only the JSON object.` },
        )
      }
      throw new LlmError(`output_invalid: ${name}`, 422, false)
    },
  }
}
