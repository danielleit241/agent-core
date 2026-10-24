import { startShop } from '@agent-core/shop'

const shop = await startShop(undefined, 7400)
console.log(`mock shop MCP URL: ${shop.url}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shop.close().then(() => process.exit(0))
  })
}
