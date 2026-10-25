import type { ToolDescriptor, ToolInvoker } from '@agent-core/core'
import { signPrincipalJwt, signWebhook } from '@agent-core/protocol'

export class WebhookToolError extends Error {
  constructor(
    message: string,
    readonly code: 'connection_unavailable' | 'connection_unreachable' | 'tool_call_failed' | 'dry_run_not_supported',
    /** true when the request was never sent, so the call is safe to retry. */
    readonly notSent: boolean,
    /** A fixed, URL-free reason such as `HTTP 503` or `timeout`; the run records it as evidence. */
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'WebhookToolError'
  }
}

const MAX_BODY_BYTES = 1024 * 1024
const MAX_ERROR_CHARS = 2000
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

/** Internal: carries a fixed, URL-free reason up to `attempt`, which adds the connection id. */
class Failure extends Error {}

function networkCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | null)?.cause
  if (typeof cause?.code === 'string') return cause.code
  // Node reports a failed connect to several addresses as an AggregateError.
  const first = cause?.errors?.[0]?.code
  return typeof first === 'string' ? first : undefined
}

/** Reads the body as text; stops with a Failure past the limit. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Failure('response too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const failed = (id: string, detail: string) => new WebhookToolError(`tool_call_failed: ${id}: ${detail}`, 'tool_call_failed', false, detail)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function createWebhookInvoker(
  resolve: (connectionId: string) => Promise<{ url: string; secret: string }>,
  o: { timeoutMs?: number; fetch?: typeof fetch; nowMs?: () => number } = {},
): ToolInvoker {
  const timeoutMs = o.timeoutMs ?? 15_000
  const doFetch = o.fetch ?? fetch
  const nowMs = o.nowMs ?? Date.now

  async function attempt(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
    ctx: Parameters<ToolInvoker['call']>[2],
  ): Promise<{ content: string; isError: boolean }> {
    const id = tool.connectionId
    let conn: { url: string; secret: string }
    try {
      conn = await resolve(id)
    } catch {
      // The cause may carry credentials, so only the connection id is reported.
      throw new WebhookToolError(`connection_unavailable: ${id}`, 'connection_unavailable', true)
    }
    const nowSec = Math.floor(nowMs() / 1000)
    // The key and the dry-run flag go in the signed body: the headers alone could be changed in transit.
    const body = JSON.stringify({ tool: tool.name, input: args, idempotencyKey: ctx.idempotencyKey, dryRun: ctx.dryRun })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-AgentCore-Signature': signWebhook(body, conn.secret, nowSec),
      'Idempotency-Key': ctx.idempotencyKey,
      'X-AgentCore-Dry-Run': String(ctx.dryRun),
    }
    if (ctx.principal) headers['X-AgentCore-Principal'] = signPrincipalJwt(ctx.principal, { secret: conn.secret, audience: id, nowSec })

    // Errors name the connection, never the URL or the cause: both can carry credentials.
    let status: number
    let text: string
    try {
      const res = await doFetch(`${conn.url.replace(/\/+$/, '')}/${encodeURIComponent(tool.name)}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = res.status
      text = status >= 300 && status < 400 ? '' : await readCapped(res)
    } catch (err) {
      if (err instanceof Failure) throw failed(id, err.message)
      const name = (err as { name?: unknown } | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw failed(id, 'timeout')
      }
      const code = networkCode(err)
      if (code !== undefined && UNREACHABLE_CODES.has(code)) {
        throw new WebhookToolError(`connection_unreachable: ${id}`, 'connection_unreachable', true)
      }
      throw failed(id, 'connection error')
    }

    if (status >= 200 && status < 300) {
      const parsed = parseJson(text)
      if (!isObject(parsed) || !('output' in parsed)) {
        // A 2xx means the call was accepted: a write may have run, so its outcome is unknown.
        if (tool.safety.effect !== 'read') throw failed(id, 'invalid response')
        return { content: 'Tool returned an invalid response.', isError: true }
      }
      const out = parsed.output
      return { content: typeof out === 'string' ? out : (JSON.stringify(out) ?? 'null'), isError: false }
    }
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      const parsed = parseJson(text)
      const message = isObject(parsed) && isObject(parsed.error) ? parsed.error.message : undefined
      return {
        content: typeof message === 'string' && message !== '' ? message.slice(0, MAX_ERROR_CHARS) : `Tool returned HTTP ${status}.`,
        isError: true,
      }
    }
    throw failed(id, `HTTP ${status}`)
  }

  return {
    async call(tool, args, ctx) {
      if (ctx.dryRun && tool.safety.effect === 'write' && tool.supports?.includes('dry-run') !== true) {
        throw new WebhookToolError(`dry_run_not_supported: ${tool.name}`, 'dry_run_not_supported', true)
      }
      try {
        return await attempt(tool, args, ctx)
      } catch (err) {
        // Only reads are retried (once, same key); a write may already have executed.
        if (tool.safety.effect !== 'read' || !(err instanceof WebhookToolError) || err.notSent) throw err
        return attempt(tool, args, ctx)
      }
    },
  }
}
