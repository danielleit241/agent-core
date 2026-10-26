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
cp .env.example .env     # set LLM_API_KEY, LLM_MODEL_DEFAULT and AGENT_CORE_MASTER_KEY (openssl rand -base64 32); any OpenAI-compatible endpoint works
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

# 1. Connect the mock shop. The service discovers its tools; each one starts with the strictest
#    safety (a write that reaches outside) and a "proposed" safety read from the tool's hints.
curl -s -X POST localhost:7300/v1/connections -H "$AUTH" -H "$JSON" -d '{"id":"shop","url":"http://127.0.0.1:7400/mcp"}'

# 1b. Review the proposals, then confirm them. Until you do, even orders.get waits for approval.
curl -s localhost:7300/v1/connections/shop/tools -H "$AUTH"
for t in orders.get inventory.check payments.refund orders.change_size; do
  curl -s -X PATCH localhost:7300/v1/connections/shop/tools/$t -H "$AUTH" -H "$JSON" -d '{"confirm":"proposed"}'
done

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

### More of the API

- **Tool safety.** `GET /v1/connections/{id}/tools` shows each tool's `description` and `inputSchema` (what the model sees), its `safety`, its `proposed` safety, `needsConfirmation` and a `fingerprint` of its definition (name, description, input schema, hints and declarations). `PATCH /v1/connections/{id}/tools/{tool}` takes `{"confirm":"proposed"}` or a partial safety such as `{"idempotency":true}`. Hints can only make a tool stricter; loosening always needs this call. When a tool's definition changes after you saw it (at registration or at your last confirmation), it shows `"changedSinceReview": true`: the model no longer sees it, because its new description is unreviewed text that reaches the model. Its confirmations no longer count, and a call that was already made waits for approval, even when an agent's `allow` rule matches, because that rule was written for the old definition. Confirm it again to clear this. Registering a connection again at a different URL drops every confirmation, and a tool that appears when a connection is registered again also shows `changedSinceReview` until you confirm it. Add the `fingerprint` you reviewed to the `PATCH` body to make sure you confirm what you saw; if the tool changed since, the answer is `409 tool_changed` and nothing is confirmed. The `fingerprint` is required while a tool shows `changedSinceReview`; without it the answer is `428 fingerprint_required`.
- **Webhook tools.** `POST /v1/connections` with `"kind":"webhook"`, a `url` and a list of `tools` (name, description, `inputSchema`, `safety`, optional `supports`). The `201` response holds the connection `secret` once; keep it. Each call is a signed `POST <url>/<tool>` with an idempotency key and, when the run has a principal, an HS256 principal JWT. The full contract: [packages/tools/README.md](packages/tools/README.md).
- **Unknown outcomes.** When a write was sent but its result was lost, the run waits with `"waiting_reason":"unknown_outcome"` and a `pending_outcome`, whose `reason` says what went wrong (for example `HTTP 503` after the call was sent). Send `POST /v1/runs/{id}/resolve` with `outcome_happened` (continue without calling again), `outcome_not_happened` (call again with the same idempotency key) or `cancel`. `POST /v1/runs/{id}/cancel` cancels a queued or waiting run. Subscribe to `run.waiting_human` to hear about these runs.
- **Models.** `pnpm models:check` probes each model alias (tool calls, parallel tools, strict JSON schema, usage cost) and prints a proposed profile; `--apply` stores it. `GET /v1/models` shows the profiles. For a model without strict JSON schema, structured output is validated and retried.

### Tests

```bash
pnpm test         # unit tests
pnpm test:db      # tests that need Postgres (*.db.test.ts)
pnpm e2e          # end-to-end over real HTTP, with a fake LLM
pnpm smoke:live   # one run against a real model; uses LLM_BASE_URL and LLM_API_KEY; skips when they are not set
pnpm eval         # shop eval scenarios, replayed from a recorded cassette (no LLM calls); see apps/evals/README.md
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
