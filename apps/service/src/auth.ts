import { createHash, timingSafeEqual } from 'node:crypto'
import { apiError } from './errors'

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest()

/** Throws 401 unless the Authorization header carries the admin key. Compares fixed-size digests in constant time. */
export function checkAdminKey(header: string | undefined, adminKey: string): void {
  const given = header?.match(/^Bearer (.+)$/i)?.[1]
  if (given === undefined || !timingSafeEqual(sha256(given), sha256(adminKey))) {
    throw apiError(
      'unauthorized',
      'Missing or invalid admin key.',
      'Send the header "Authorization: Bearer <AGENT_CORE_ADMIN_KEY>".',
      401,
    )
  }
}
