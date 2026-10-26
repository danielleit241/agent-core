import { verifyChain } from '@agent-core/core'
import type { StoredEvent } from '@agent-core/core'
import type { CliEnv, CliIo } from './main'

/** Exit 0: chain intact. 1: broken. 2: the log could not be read. */
export async function logVerify(runId: string, env: CliEnv, io: CliIo): Promise<number> {
  const base = (env.AGENT_CORE_URL ?? 'http://localhost:7300').replace(/\/+$/, '')
  const key = env.AGENT_CORE_API_KEY
  if (!key) {
    io.err('error: set AGENT_CORE_API_KEY to an API key of the run\'s tenant.')
    return 2
  }
  let res: Response
  try {
    res = await io.fetch(`${base}/v1/runs/${encodeURIComponent(runId)}/events`, { headers: { authorization: `Bearer ${key}` } })
  } catch {
    io.err(`error: cannot reach ${base}. Check AGENT_CORE_URL and that the service is running.`)
    return 2
  }
  if (res.status === 401 || res.status === 403) {
    io.err('error: the API key was refused. Check AGENT_CORE_API_KEY.')
    return 2
  }
  if (res.status === 404) {
    io.err(`error: run "${runId}" was not found for this key.`)
    return 2
  }
  if (!res.ok) {
    io.err(`error: the service answered ${res.status}.`)
    return 2
  }
  let events: StoredEvent[]
  try {
    const body = (await res.json()) as { events?: unknown }
    if (!Array.isArray(body.events)) throw new Error('no events')
    events = body.events as StoredEvent[]
  } catch {
    io.err('error: the answer is not a run event list.')
    return 2
  }
  // The chain is recomputed here; the server's own `chain` field is not trusted.
  const chain = verifyChain(events)
  if (!chain.valid) {
    io.out(`broken at seq ${chain.brokenAtSeq}`)
    return 1
  }
  io.out(`ok: ${events.length} events`)
  return 0
}
