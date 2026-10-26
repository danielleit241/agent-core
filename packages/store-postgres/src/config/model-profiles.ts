import type pg from 'pg'
import type { ModelProfile } from '@agent-core/core'
import { withService } from '../db/scope'

export type ProbeRecord = { name: string; ok: boolean; detail: string }
/** A stored model. `profile` is the truth; `proposed` comes from a check and changes nothing by itself. */
export type ModelProfileRow = {
  model: string
  profile: ModelProfile | null
  proposed: ModelProfile | null
  probes: ProbeRecord[] | null
  checkedAt: Date | null
}

/** Model capabilities, keyed by the real model id. Service-wide. */
export class ModelProfileRepo {
  constructor(private readonly pool: pg.Pool) {}

  async get(model: string): Promise<ModelProfileRow | null> {
    const res = await withService(this.pool, (c) => c.query(
      'SELECT model, profile, proposed, probes, checked_at FROM model_profiles WHERE model = $1',
      [model],
    ))
    const r = res.rows[0]
    return r ? { model: r.model, profile: r.profile, proposed: r.proposed, probes: r.probes, checkedAt: r.checked_at } : null
  }

  async setProfile(model: string, profile: ModelProfile): Promise<void> {
    await withService(this.pool, (c) => c.query(
      `INSERT INTO model_profiles (model, profile) VALUES ($1, $2)
       ON CONFLICT (model) DO UPDATE SET profile = EXCLUDED.profile, updated_at = now()`,
      [model, JSON.stringify(profile)],
    ))
  }

  async setProposal(model: string, proposed: ModelProfile, probes: ProbeRecord[]): Promise<void> {
    await withService(this.pool, (c) => c.query(
      `INSERT INTO model_profiles (model, proposed, probes, checked_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (model) DO UPDATE SET proposed = EXCLUDED.proposed, probes = EXCLUDED.probes, checked_at = now(), updated_at = now()`,
      [model, JSON.stringify(proposed), JSON.stringify(probes)],
    ))
  }
}
