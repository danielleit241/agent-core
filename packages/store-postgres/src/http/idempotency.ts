import type pg from 'pg'
import { withTenant } from '../db/scope'

/** A request without a stored answer older than this is treated as a crashed request and may be taken over. */
const IN_FLIGHT_SECONDS = 60

export type BeginResult =
  | { state: 'started' }
  | { state: 'mismatch' }
  | { state: 'replay'; statusCode: number; body: string }
  | { state: 'in_use' }

/**
 * Claims an idempotency key for a request. `started` means the caller owns the key and must call
 * `completeIdempotent` or `abandonIdempotent`. Other states tell the caller to answer without running the handler.
 */
export async function beginIdempotent(pool: pg.Pool, tenantId: string, key: string, requestHash: string): Promise<BeginResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await withTenant(pool, tenantId, (client) =>
      client.query('INSERT INTO idempotency_keys (tenant_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
        tenantId,
        key,
        requestHash,
      ]),
    )
    if (inserted.rowCount === 1) return { state: 'started' }
    const res = await withTenant(pool, tenantId, (client) =>
      client.query<{ request_hash: string; status_code: number | null; response_body: string | null; stale: boolean }>(
        `SELECT request_hash, status_code, response_body, created_at < now() - make_interval(secs => $3) AS stale
         FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
        [tenantId, key, IN_FLIGHT_SECONDS],
      ),
    )
    const row = res.rows[0]
    if (!row) continue // abandoned between the insert and the select: try again
    if (row.request_hash !== requestHash) return { state: 'mismatch' }
    if (row.status_code !== null) return { state: 'replay', statusCode: row.status_code, body: row.response_body ?? '' }
    if (!row.stale) return { state: 'in_use' }
    const taken = await withTenant(pool, tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET created_at = now()
         WHERE tenant_id = $1 AND key = $2 AND status_code IS NULL AND created_at < now() - make_interval(secs => $3)`,
        [tenantId, key, IN_FLIGHT_SECONDS],
      ),
    )
    return taken.rowCount === 1 ? { state: 'started' } : { state: 'in_use' }
  }
  return { state: 'in_use' }
}

/** Stores the answer, so a repeat of the request gets the same answer. */
export async function completeIdempotent(
  pool: pg.Pool,
  tenantId: string,
  key: string,
  statusCode: number,
  body: string,
): Promise<void> {
  await withTenant(pool, tenantId, (client) =>
    client.query('UPDATE idempotency_keys SET status_code = $3, response_body = $4 WHERE tenant_id = $1 AND key = $2', [
      tenantId,
      key,
      statusCode,
      body,
    ]),
  )
}

/** Releases the key after a failed request, so the caller can retry with it. */
export async function abandonIdempotent(pool: pg.Pool, tenantId: string, key: string): Promise<void> {
  await withTenant(pool, tenantId, (client) =>
    client.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 AND status_code IS NULL', [tenantId, key]),
  )
}
