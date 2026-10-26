import type pg from 'pg'
import { contentHash } from '@agent-core/core'
import type { ContentStore } from '@agent-core/core'
import { withTenant } from '../db/scope'

/** Content store in Postgres, one namespace per tenant: the same text in two tenants is stored twice. */
export class PgContentStore implements ContentStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
  ) {}

  put(texts: string[]): Promise<string[]> {
    const hashes = texts.map(contentHash)
    if (texts.length === 0) return Promise.resolve(hashes)
    return withTenant(this.pool, this.tenantId, async (client) => {
      const { rows } = await client.query<{ hash: string }>('SELECT hash FROM context_blobs WHERE tenant_id = $1 AND hash = ANY($2)', [
        this.tenantId,
        hashes,
      ])
      const have = new Set(rows.map((r) => r.hash))
      const missing = new Map<string, string>()
      texts.forEach((text, i) => {
        if (!have.has(hashes[i]!)) missing.set(hashes[i]!, text)
      })
      // Sorted by hash: two writers that insert overlapping sets take the row locks in the same order.
      const sorted = [...missing].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      if (missing.size > 0) {
        // Another worker may insert the same text between the SELECT and here; the conflict is a no-op.
        await client.query(
          'INSERT INTO context_blobs (tenant_id, hash, content) SELECT $1, * FROM unnest($2::text[], $3::text[]) ON CONFLICT DO NOTHING',
          [this.tenantId, sorted.map(([h]) => h), sorted.map(([, t]) => t)],
        )
      }
      return hashes
    })
  }

  get(hashes: string[]): Promise<Map<string, string>> {
    if (hashes.length === 0) return Promise.resolve(new Map())
    return withTenant(this.pool, this.tenantId, async (client) => {
      const { rows } = await client.query<{ hash: string; content: string }>(
        'SELECT hash, content FROM context_blobs WHERE tenant_id = $1 AND hash = ANY($2)',
        [this.tenantId, hashes],
      )
      return new Map(rows.map((r) => [r.hash, r.content]))
    })
  }
}
