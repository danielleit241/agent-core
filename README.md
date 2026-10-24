# agent-core

An open-source agent service. Teams connect their systems through standard protocols; agent-core runs the harness: agent loop, tool calls, rules, human approval and an event log.

> **Status: in development.** No released version yet; not for production. See [ROADMAP.md](ROADMAP.md).

## How it works

| Gate | Direction | Protocols |
|---|---|---|
| **In** | Your system → agent | Control API (`POST /v1/runs`), channels |
| **Tool** | Agent → your system | MCP, OpenAPI, signed webhook tools |
| **Out** | Agent → your system | Signed webhooks, SSE, OpenTelemetry |

- **Safe by default:** unknown tools are treated as writes; writes wait for a human.
- **Rules in code:** a rule gate checks every tool call before it runs.
- **Event log:** every run is append-only and hash-chained, so you can verify it.

## Quickstart

Prerequisites: Node.js 24, pnpm 10 and Docker.

```bash
pnpm install
cp .env.example .env     # set LLM_API_KEY and LLM_MODEL_DEFAULT; any OpenAI-compatible endpoint works
pnpm db:up               # Postgres on localhost:5433
pnpm mock:shop           # terminal 2: mock shop MCP server on http://127.0.0.1:7400/mcp
pnpm dev                 # terminal 1: agent-core on http://localhost:7300
```

`pnpm dev` restarts on file changes. `pnpm start` runs without watching. Both read `.env`.

Then call the Control API. The key is `AGENT_CORE_ADMIN_KEY` from `.env`.

```bash
export AGENT_CORE_ADMIN_KEY=change-me
AUTH="Authorization: Bearer $AGENT_CORE_ADMIN_KEY"
JSON="Content-Type: application/json"

# 1. Connect the mock shop (the service discovers its tools)
curl -s -X POST localhost:7300/v1/connections -H "$AUTH" -H "$JSON"   -d '{"id":"shop","url":"http://127.0.0.1:7400/mcp"}'

# 2. Create an agent. Refunds up to 1,000,000 are allowed; larger ones wait for a human.
curl -s -X POST localhost:7300/v1/agents -H "$AUTH" -H "$JSON" -d '{
  "id": "retail-support",
  "instructions": "You are a support assistant for a shop. Use the tools to look up orders and refund them.",
  "connections": ["shop"],
  "autonomy": "supervised",
  "allow": [{ "tool": "payments.refund", "when": { "amount": { "lte": 1000000 } } }]
}'

# 3. Start a run. ?wait=30 holds the request until the run settles (up to 30 seconds).
curl -s -X POST "localhost:7300/v1/runs?wait=30" -H "$AUTH" -H "$JSON" -d '{
  "agent": "retail-support",
  "input": { "text": "My shirt is defective, please refund order 1042" },
  "principal": { "id": "cus_2291", "roles": ["customer"] }
}'
```

Order 1042 costs 1,200,000, so the run stops with `"status":"waiting_human"` and a `pending_approval`. Use the run `id` from that response:

```bash
RUN=run_...   # the "id" field

# 4. Approve (or send {"action":"reject"})
curl -s -X POST localhost:7300/v1/runs/$RUN/resolve -H "$AUTH" -H "$JSON" -d '{"action":"approve"}'

# 5. Read the result, then the hash-chained event log
curl -s localhost:7300/v1/runs/$RUN -H "$AUTH"
curl -s localhost:7300/v1/runs/$RUN/events -H "$AUTH"
```

Without `?wait`, `POST /v1/runs` returns `202` with `run_id` at once. Poll `GET /v1/runs/{id}` instead.

### Tests

```bash
pnpm test         # unit tests
pnpm test:db      # tests that need Postgres (*.db.test.ts)
pnpm e2e          # end-to-end over real HTTP, with a fake LLM
pnpm smoke:live   # one run against a real model; uses LLM_BASE_URL and LLM_API_KEY; skips when they are not set
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
