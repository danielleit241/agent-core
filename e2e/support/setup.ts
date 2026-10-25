import type { Stack } from './harness'

/** Registers the mock shop as connection `shop` and confirms every tool's proposed safety. */
export async function registerShop(s: Pick<Stack, 'api' | 'shop'>): Promise<void> {
  const conn = await s.api('POST', '/v1/connections', { id: 'shop', url: s.shop.url })
  if (conn.status >= 300) throw new Error(`registering connection failed: ${conn.status}`)
  for (const t of conn.body.tools as { name: string }[]) {
    const res = await s.api('PATCH', `/v1/connections/shop/tools/${encodeURIComponent(t.name)}`, { confirm: 'proposed' })
    if (res.status >= 300) throw new Error(`confirming tool ${t.name} failed: ${res.status}`)
  }
}
