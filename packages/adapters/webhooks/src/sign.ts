import { createHmac, timingSafeEqual } from 'node:crypto'

const hmacHex = (secret: string, t: number, body: string): string =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')

/** Returns the `X-AgentCore-Signature` header value: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signWebhook(body: string, secret: string, nowSec: number): string {
  return `t=${nowSec},v1=${hmacHex(secret, nowSec, body)}`
}

/** Never throws: any malformed input, wrong secret or timestamp outside the tolerance returns false. */
export function verifyWebhook(body: string, header: string, secret: string, nowSec: number, toleranceSec = 300): boolean {
  const parts = new Map<string, string>()
  for (const p of header.split(',')) {
    const i = p.indexOf('=')
    if (i > 0) parts.set(p.slice(0, i).trim(), p.slice(i + 1).trim())
  }
  const tRaw = parts.get('t')
  const v1 = parts.get('v1')
  if (tRaw === undefined || v1 === undefined || !/^\d+$/.test(tRaw) || !/^[0-9a-f]{64}$/.test(v1)) return false
  const t = Number(tRaw)
  if (!Number.isSafeInteger(t) || Math.abs(nowSec - t) > toleranceSec) return false
  const expected = Buffer.from(hmacHex(secret, t, body), 'hex')
  const given = Buffer.from(v1, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
