import type pg from 'pg'

type Job = { runId: string; tenantId: string; availableAt?: Date }

export async function enqueue(pool: pg.Pool, job: Job): Promise<void> {
  await enqueueWith(pool, job)
}

/**
 * Upserts the job on any pool or client, so a caller can do it inside its own transaction.
 * An existing row is unlocked, so a worker still holding it cannot delete the new job.
 */
export async function enqueueWith(db: Pick<pg.Pool, 'query'>, job: Job): Promise<void> {
  await db.query(
    `INSERT INTO queue (run_id, tenant_id, available_at) VALUES ($1, $2, COALESCE($3, now()))
     ON CONFLICT (run_id) DO UPDATE SET available_at = EXCLUDED.available_at, locked_by = NULL, locked_at = NULL`,
    [job.runId, job.tenantId, job.availableAt ?? null],
  )
}

export async function claim(
  pool: pg.Pool,
  workerId: string,
  lockTimeoutMs = 300000,
): Promise<{ runId: string; tenantId: string } | null> {
  const res = await pool.query<{ run_id: string; tenant_id: string }>(
    `UPDATE queue SET locked_by = $1, locked_at = now()
     WHERE run_id = (
       SELECT run_id FROM queue
       WHERE available_at <= now() AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2 / 1000.0))
       ORDER BY priority DESC, available_at
       LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING run_id, tenant_id`,
    [workerId, lockTimeoutMs],
  )
  const row = res.rows[0]
  return row ? { runId: row.run_id, tenantId: row.tenant_id } : null
}

export async function release(pool: pg.Pool, runId: string, workerId: string): Promise<void> {
  await pool.query('DELETE FROM queue WHERE run_id = $1 AND locked_by = $2', [runId, workerId])
}

/** Refreshes the lock timestamp. Returns false when this worker no longer holds the job. */
export async function heartbeat(pool: pg.Pool, runId: string, workerId: string): Promise<boolean> {
  const res = await pool.query('UPDATE queue SET locked_at = now() WHERE run_id = $1 AND locked_by = $2', [runId, workerId])
  return (res.rowCount ?? 0) > 0
}

/** Unlocks the job and makes it due now, but only while this worker still holds the lock. */
export async function requeueIfHolder(pool: pg.Pool, runId: string, workerId: string): Promise<void> {
  await pool.query(
    'UPDATE queue SET available_at = now(), locked_by = NULL, locked_at = NULL WHERE run_id = $1 AND locked_by = $2',
    [runId, workerId],
  )
}
