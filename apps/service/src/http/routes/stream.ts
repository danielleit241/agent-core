import type { FastifyInstance } from 'fastify'
import type { RunStatus } from '@agent-core/core'
import { PgRunStore, getRun } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { apiError } from '../errors'
import { runNotFound } from './runs'

const POLL_MS = 500
const PING_MS = 15_000
const ENDED: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

/** The seq to resume after: `Last-Event-ID` wins over `?after=`; absent means 0. */
function parseAfter(header: unknown, query: unknown): number {
  const raw = typeof header === 'string' ? header : typeof query === 'string' ? query : '0'
  if (!/^\d{1,15}$/.test(raw)) {
    throw apiError('invalid_request', 'The resume position must be a non-negative integer.', 'Use the "Last-Event-ID" header or "?after=<seq>" with the seq of the last event you got.', 400)
  }
  return Number(raw)
}

export function registerStreamRoutes(app: FastifyInstance, deps: { pool: ReturnType<typeof createPool>; closing: AbortSignal }): void {
  const { pool } = deps

  /** Server-sent events of one run: those after the resume position, then live ones until the run ends. */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/v1/runs/:id/stream', async (req, reply) => {
    const { tenantId } = req.auth
    const runId = req.params.id
    if (!(await getRun(pool, tenantId, runId))) throw runNotFound(runId)
    let after = parseAfter(req.headers['last-event-id'], req.query.after)
    const store = new PgRunStore(pool, tenantId)

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
    let gone = false
    let wake: (() => void) | undefined
    raw.on('close', () => {
      gone = true
      wake?.()
    })
    // Wakes the sleep below at once when the client leaves or the app closes.
    const sleep = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, POLL_MS)
        function done() {
          clearTimeout(timer)
          deps.closing.removeEventListener('abort', done)
          wake = undefined
          resolve()
        }
        wake = done
        deps.closing.addEventListener('abort', done, { once: true })
      })

    let lastWrite = Date.now()
    try {
      while (!gone && !deps.closing.aborted) {
        // Status before events: an ended run has all its events by the time the status is read.
        const run = await getRun(pool, tenantId, runId)
        const events = await store.readEventsAfter(runId, after)
        for (const e of events) {
          raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          after = e.seq
          lastWrite = Date.now()
        }
        if (events.length > 0) continue
        if (!run || ENDED.includes(run.status)) break
        if (Date.now() - lastWrite >= PING_MS) {
          raw.write(': ping\n\n')
          lastWrite = Date.now()
        }
        await sleep()
      }
    } catch (err) {
      // Headers are sent, so the stream just ends; the client resumes with Last-Event-ID.
      console.error('service: stream failed', err instanceof Error ? err.name : 'error')
    } finally {
      raw.end()
    }
  })
}
