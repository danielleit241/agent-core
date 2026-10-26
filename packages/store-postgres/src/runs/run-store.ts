import pg from 'pg'
import { AppendConflictError, GENESIS_HASH, NewEventSchema, hashEvent } from '@agent-core/core'
import type { NewEvent, RunStatus, RunStore, StoredEvent, WaitingReason } from '@agent-core/core'
import { withTenant } from '../db/scope'
import { enqueueWith } from './queue'

/** Refuses any database whose name does not end in `_test`; test setups reset their database. */
export function assertTestDatabase(url: string): void {
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('refusing to reset the database: TEST_DATABASE_URL must name a database ending in _test')
  }
}

/** Login URL of the runtime user for tests: `TEST_RUNTIME_DATABASE_URL`, else the migrator URL with `agentcore_runtime` credentials. */
export function runtimeTestUrl(migratorUrl: string): string {
  if (process.env.TEST_RUNTIME_DATABASE_URL) return process.env.TEST_RUNTIME_DATABASE_URL
  const u = new URL(migratorUrl)
  u.username = 'agentcore_runtime'
  u.password = 'agentcore_runtime'
  return u.toString()
}

/** Checks the database the pool really reaches; a crafted URL can hide it from `assertTestDatabase`. */
export async function assertTestPool(pool: pg.Pool): Promise<void> {
  const res = await pool.query<{ db: string }>('SELECT current_database() AS db')
  if (!res.rows[0]?.db.endsWith('_test')) {
    throw new Error('refusing to reset the database: the connected database does not end in _test')
  }
}

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url })
}

export type RunRow = {
  id: string
  agentId: string
  status: RunStatus
  waitingReason: WaitingReason | null
  createdAt: string
}

export async function createRun(
  pool: pg.Pool,
  r: {
    tenantId: string
    runId: string
    agentId: string
    agentVersion: number
    input: { text: string }
    principal?: { id: string; roles: string[] }
    idempotencyKey?: string
  },
): Promise<{ runId: string; created: boolean }> {
  // `input` and `principal` travel in the run.created event, which the caller appends.
  return withTenant(pool, r.tenantId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO runs (tenant_id, id, agent_id, agent_version, status, idempotency_key)
       VALUES ($1, $2, $3, $4, 'queued', $5)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [r.tenantId, r.runId, r.agentId, r.agentVersion, r.idempotencyKey ?? null],
    )
    if (inserted.rowCount === 1) return { runId: r.runId, created: true }
    const existing = await client.query<{ id: string }>('SELECT id FROM runs WHERE tenant_id = $1 AND idempotency_key = $2', [
      r.tenantId,
      r.idempotencyKey,
    ])
    return { runId: existing.rows[0]!.id, created: false }
  })
}

export async function getRun(pool: pg.Pool, tenantId: string, runId: string): Promise<RunRow | null> {
  const res = await withTenant(pool, tenantId, (client) =>
    client.query(
    'SELECT id, agent_id, status, waiting_reason, created_at FROM runs WHERE tenant_id = $1 AND id = $2',
    [tenantId, runId],
  ))
  const row = res.rows[0]
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    waitingReason: row.waiting_reason,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

function toStored(row: Record<string, unknown>): StoredEvent {
  return {
    tenantId: row.tenant_id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    labels: row.labels,
    agentVersion: row.agent_version,
    createdAt: (row.created_at as Date).toISOString(),
    prevHash: row.prev_hash,
    hash: row.hash,
  } as StoredEvent
}

/** Thrown by `append` when the run is not in the status the caller expected. Nothing was written. */
export class StateConflictError extends AppendConflictError {
  constructor(message: string) {
    super(message)
    this.name = 'StateConflictError'
  }
}

/** Thrown by `append` when the stored log does not match the run's head (events were deleted or changed). Nothing was written. */
export class ChainIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainIntegrityError'
  }
}

/** Thrown by a fenced store when its worker no longer holds the queue lock. Nothing was written. */
export class LockLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockLostError'
  }
}

const NUL_OR_LONE_SURROGATE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Postgres jsonb rejects U+0000 and lone surrogates, so they are replaced before validation and hashing. */
function sanitize(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(NUL_OR_LONE_SURROGATE, '\ufffd')
  if (Array.isArray(v)) return v.map(sanitize)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(NUL_OR_LONE_SURROGATE, '\ufffd'), sanitize(x)]))
  }
  return v
}

type AppendOpts = { expect?: { status?: RunStatus; waitingReason?: string; lastSeq?: number }; enqueue?: boolean }

/** Appends inside the caller's transaction: row lock, chain, status, log head and optional queue row. */
async function appendInTransaction(
  client: pg.PoolClient,
  tenantId: string,
  runId: string,
  events: NewEvent[],
  opts?: AppendOpts,
  lockedBy?: string,
): Promise<StoredEvent[]> {
  const valid = events.map((e) => NewEventSchema.parse({ ...e, payload: sanitize(e.payload) }))
  const run = await client.query<{
    agent_version: number
    status: RunStatus
    waiting_reason: string | null
    last_seq: number | null
    last_hash: string | null
  }>(
    'SELECT agent_version, status, waiting_reason, last_seq, last_hash FROM runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [tenantId, runId],
  )
  if (run.rowCount === 0) throw new Error(`run not found: ${runId}`)
  if (lockedBy !== undefined) {
    // Fence: the queue row stays locked until COMMIT, so the lock cannot change under this append.
    const lock = await client.query<{ locked_by: string | null }>('SELECT locked_by FROM queue WHERE run_id = $1 FOR UPDATE', [runId])
    if (lock.rows[0]?.locked_by !== lockedBy) throw new LockLostError(`worker ${lockedBy} no longer holds run ${runId}`)
  }
  const expect = opts?.expect
  if (
    expect &&
    ((expect.status !== undefined && run.rows[0]!.status !== expect.status) ||
      (expect.waitingReason !== undefined && run.rows[0]!.waiting_reason !== expect.waitingReason) ||
      (expect.lastSeq !== undefined && run.rows[0]!.last_seq !== expect.lastSeq))
  ) {
    throw new StateConflictError(`run ${runId} is not in the expected state`)
  }
  // A transition written from a stale read (e.g. a worker starting a run that was just cancelled) is refused.
  let status = run.rows[0]!.status
  for (const e of valid) {
    if (e.type !== 'run.state_changed') continue
    if (e.payload.from !== status) throw new StateConflictError(`run ${runId} is ${status}, not ${e.payload.from}`)
    status = e.payload.to
  }
  const agentVersion = run.rows[0]!.agent_version
  const last = await client.query<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM events WHERE run_id = $1 ORDER BY seq DESC LIMIT 1',
    [runId],
  )
  const head = run.rows[0]!
  if ((last.rows[0]?.seq ?? null) !== head.last_seq || (last.rows[0]?.hash ?? null) !== head.last_hash) {
    throw new ChainIntegrityError(`stored events of run ${runId} do not match the run's log head`)
  }
  let seq = last.rows[0]?.seq ?? 0
  let prevHash = last.rows[0]?.hash ?? GENESIS_HASH
  const stored: StoredEvent[] = []
  for (const e of valid) {
    seq += 1
    const base = {
      ...e,
      tenantId,
      runId,
      seq,
      agentVersion,
      createdAt: new Date().toISOString(),
      prevHash,
    }
    const hash = hashEvent(base)
    await client.query(
      `INSERT INTO events (tenant_id, run_id, seq, type, payload, labels, agent_version, created_at, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenantId, runId, seq, e.type, JSON.stringify(e.payload), e.labels, agentVersion, base.createdAt, prevHash, hash],
    )
    if (e.type === 'run.state_changed') {
      const to = e.payload.to
      await client.query(
        'UPDATE runs SET status = $1, waiting_reason = $2, updated_at = now() WHERE tenant_id = $3 AND id = $4',
        [to, to === 'waiting_human' ? (e.payload.reason ?? null) : null, tenantId, runId],
      )
    }
    stored.push({ ...base, hash } as StoredEvent)
    prevHash = hash
  }
  if (stored.length > 0) {
    await client.query('UPDATE runs SET last_seq = $1, last_hash = $2 WHERE tenant_id = $3 AND id = $4', [
      seq,
      prevHash,
      tenantId,
      runId,
    ])
  }
  if (opts?.enqueue) await enqueueWith(client, { runId, tenantId })
  return stored
}

/**
 * Inserts the run, appends `created` (the `run.created` event) and enqueues the job in one transaction.
 * A replayed idempotency key returns the first run and writes nothing.
 */
export async function createRunWithEvent(
  pool: pg.Pool,
  r: {
    tenantId: string
    runId: string
    agentId: string
    agentVersion: number
    idempotencyKey?: string
    /** Hash of the request. A replay returns the stored hash, so the caller can refuse a different request. */
    requestHash?: string
    created: NewEvent
  },
): Promise<{ id: string; created: boolean; requestHash: string | null }> {
  return withTenant(pool, r.tenantId, async (client) => {
    const inserted = await client.query(
      `INSERT INTO runs (tenant_id, id, agent_id, agent_version, status, idempotency_key, idempotency_request_hash)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [r.tenantId, r.runId, r.agentId, r.agentVersion, r.idempotencyKey ?? null, r.requestHash ?? null],
    )
    if (inserted.rowCount === 1) {
      await appendInTransaction(client, r.tenantId, r.runId, [r.created], { enqueue: true })
      return { id: r.runId, created: true, requestHash: r.requestHash ?? null }
    }
    const existing = await client.query<{ id: string; idempotency_request_hash: string | null }>(
      'SELECT id, idempotency_request_hash FROM runs WHERE tenant_id = $1 AND idempotency_key = $2',
      [r.tenantId, r.idempotencyKey],
    )
    const row = existing.rows[0]!
    return { id: row.id, created: false, requestHash: row.idempotency_request_hash }
  })
}

/** The stored log head of a run, or null when the run does not exist. Both fields are null before the first event. */
export async function getRunHead(
  pool: pg.Pool,
  tenantId: string,
  runId: string,
): Promise<{ lastSeq: number | null; lastHash: string | null } | null> {
  const res = await withTenant(pool, tenantId, (client) =>
    client.query<{ last_seq: number | null; last_hash: string | null }>(
    'SELECT last_seq, last_hash FROM runs WHERE tenant_id = $1 AND id = $2',
    [tenantId, runId],
  ))
  const row = res.rows[0]
  return row ? { lastSeq: row.last_seq, lastHash: row.last_hash } : null
}

export class PgRunStore implements RunStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
    private readonly fence?: { lockedBy: string },
  ) {}

  async readEvents(runId: string): Promise<StoredEvent[]> {
    const res = await withTenant(this.pool, this.tenantId, (client) =>
      client.query(
      'SELECT * FROM events WHERE tenant_id = $1 AND run_id = $2 ORDER BY seq',
      [this.tenantId, runId],
    ))
    return res.rows.map(toStored)
  }

  /** Sum of `usage.costUsd` over the tenant's LLM responses since `since`. A response without a cost adds 0. */
  async tenantCostSince(since: Date): Promise<number> {
    const res = await withTenant(this.pool, this.tenantId, (client) =>
      client.query<{ cost: string }>(
        `SELECT COALESCE(SUM((payload->'usage'->>'costUsd')::numeric), 0) AS cost FROM events
         WHERE tenant_id = $1 AND type = 'llm.responded' AND created_at >= $2`,
        [this.tenantId, since],
      ),
    )
    return Number(res.rows[0]!.cost)
  }

  async append(runId: string, events: NewEvent[], opts?: AppendOpts): Promise<StoredEvent[]> {
    return withTenant(this.pool, this.tenantId, (client) => appendInTransaction(client, this.tenantId, runId, events, opts, this.fence?.lockedBy))
  }
}
