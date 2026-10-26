# agent-core

**An open-source, domain-agnostic agent service.** Register an agent, connect your systems, get an API key. agent-core runs the harness: the agent loop, tool calls, rules, human approval, durable runs and a verifiable event log.

You manage the agent. The service runs it.

> **Status: in development.** No released version yet; not for production. The pictures below show the target design, not only what is built. [ROADMAP.md](ROADMAP.md) is the one place that tracks progress: a ticked task is built.

![agent-core architecture: your systems connect through three gates (in, tool, out) to the agent-core service, which runs every task through a seven-stage run harness](docs/assets/architecture.webp)

## Why agent-core

Building an agent is easy. Running one safely against real systems is not. Each team ends up rebuilding the same harness: retries, approvals, permissions, audit logs, evals. agent-core is that harness, as one service that many agents and teams share.

- **Safe by default.** An unknown tool counts as a write that reaches outside. Writes wait for a human until a rule allows them. A rule gate checks every tool call before it runs, and code never loosens a rule by itself.
- **Your systems, standard protocols.** No team code runs inside the service. Everything connects through three gates:

  | Gate | Direction | Protocols |
  |---|---|---|
  | **In** | Your system → agent | Control API (`POST /v1/runs`), later channels and triggers |
  | **Tool** | Agent → your system | MCP, signed webhook tools, later OpenAPI |
  | **Out** | Agent → your system | Signed webhooks, later SSE and OpenTelemetry |

- **Verifiable.** Every run is an append-only, hash-chained event log. Run state is recomputed from events, so you can check what happened and why.
- **Domain-agnostic.** The same core runs a support agent, a research agent or an operations agent. A new agent is configuration, not a code change.

## Use cases

![Use cases: research and analysis, data processing, automated operations, software development, business intelligence and customer support, all on the same agent-core platform](docs/assets/use-cases.webp)

The first reference agent is `retail-support`: it looks up orders and refunds them, and a human approves large refunds. The quickstart below runs it against a mock shop.

## Quickstart

### Docker only

```bash
docker compose up -d --build   # Postgres and agent-core on http://localhost:7300
docker compose logs agent-core # the generated admin key is printed once (ak_admin....)
```

The container needs no `.env`. To enable runs, copy `.env.example` to `.env`, set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL_DEFAULT`, then run `docker compose up -d` again. The compose file sets `DATABASE_URL` and `MIGRATOR_DATABASE_URL` for the container, so the `localhost:5433` values in `.env` do not apply there. `master.key` and the admin key live in the `agent-core-data` volume. Run the CLI inside the container with `docker compose exec agent-core agent-core log verify <run-id>`. `pnpm db:up` still starts only Postgres.

### From source

Prerequisites: Node.js 24, pnpm 10 and Docker.

```bash
pnpm install
cp .env.example .env     # set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL_DEFAULT; any OpenAI-compatible endpoint works
pnpm db:up               # Postgres on localhost:5433
pnpm mock:shop           # terminal 2: mock shop MCP server on http://127.0.0.1:7400/mcp
pnpm dev                 # terminal 1: agent-core on http://localhost:7300
```

On the first start, without `AGENT_CORE_ADMIN_KEY`, the service prints a generated admin key once (`ak_admin.…`). Store it: only its hash is kept. To use your own key, or if you lose it, set `AGENT_CORE_ADMIN_KEY` and restart. Without `AGENT_CORE_MASTER_KEY` the service creates `master.key` in `AGENT_CORE_DATA_DIR` (default `./.data`); back it up, or set the variable for production. Without LLM settings the service still starts, and `GET /readyz` reports `llm_not_configured`.

A run that names no `agent` uses the built-in `default` agent. Then connect the shop, create an agent and start a run. Put the admin key in `AUTH` below.

```bash
AUTH="Authorization: Bearer <your admin key>"
JSON="Content-Type: application/json"

# 1. Connect the mock shop, then confirm the safety the service proposes for each tool.
curl -s -X POST localhost:7300/v1/connections -H "$AUTH" -H "$JSON" -d '{"id":"shop","url":"http://127.0.0.1:7400/mcp"}'
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

# 3. Start a run and wait up to 30 seconds for it to settle.
curl -s -X POST "localhost:7300/v1/runs?wait=30" -H "$AUTH" -H "$JSON" -d '{
  "agent": "retail-support",
  "input": { "text": "My shirt is defective, please refund order 1042" },
  "principal": { "id": "cus_2291", "roles": ["customer"] }
}'
```

Order 1042 costs 1,200,000, so the run stops with `"status":"waiting_human"`. Approve it, then read the result and the event log:

```bash
RUN=run_...   # the "id" from the response
curl -s -X POST localhost:7300/v1/runs/$RUN/input -H "$AUTH" -H "$JSON" -d '{"action":"approve"}'
curl -s localhost:7300/v1/runs/$RUN -H "$AUTH"
curl -s localhost:7300/v1/runs/$RUN/events -H "$AUTH"
```

### More of the API

- **Context snapshots.** Every LLM request is stored by content hash, once per tenant. `GET /v1/runs/{id}/llm-calls` lists the calls with `parts`, `newParts` (parts first seen in that call) and `chars` per role (`system`, `user`, `assistant`, `tool`, `tools`). `GET /v1/runs/{id}/llm-calls/{seq}` returns the `messages`, `tools` and output schema the runner passed to the LLM adapter in one call (an adapter may rewrite them, for example merge system messages), or 404 for a call logged without a snapshot.
- **Tool safety.** `GET /v1/connections/{id}/tools` shows what the model sees and each tool's safety. Hints only make a tool stricter; loosening needs `PATCH /v1/connections/{id}/tools/{tool}`. A tool whose definition changed since review is hidden from the model until you confirm it again.
- **Webhook tools.** Register a connection with `"kind":"webhook"`. Each call is a signed `POST` with an idempotency key. Contract: [packages/tools/README.md](packages/tools/README.md).
- **Offloaded outputs.** Content longer than the agent's `tool_output_chars` limit (default 8,000 characters) is stored whole by content hash. The limit is the offload threshold: it is not a breach and does not pause the run. This covers tool outputs, the run input, messages and answers. The log and the LLM see a preview (the first 1,200 and the last 400 characters, the size, and an outline of JSON) with a handle `out_...`, and the event has an `offload` field. The agent reads the rest with the built-in `agent_core.read_output` (`{"handle", "search"}` for a case-insensitive text search, or `{"handle", "offset", "length"}` for a range of at most 6,000 characters). The tool is offered only after the run holds a handle, works only on handles of the same run, and its result carries the labels of the output. `GET /v1/runs/{id}/outputs/{handle}` returns the full text. A preview is at most about 2,100 characters, and one `read_output` call returns at most 6,500. In a workflow, a tool step whose output was offloaded has the preview as its step output, so a `$ref` into its fields has no value: a workflow that needs fields of a large output raises `tool_output_chars` for that agent (admin key). The input of a workflow run is never offloaded.
- **Offloaded outputs.** Content longer than the agent's `tool_output_chars` limit (default 8,000 characters) is stored whole by content hash. This covers tool outputs, the run input, messages and answers. The log and the LLM see a preview (the first 1,200 and the last 400 characters, the size, and an outline of JSON) with a handle `out_...`, and the event has an `offload` field. The agent reads the rest with the built-in `agent_core.read_output` (`{"handle", "search"}` for a case-insensitive text search, or `{"handle", "offset", "length"}` for a range of at most 6,000 characters). The tool is offered only after the run holds a handle, works only on handles of the same run, and its result carries the labels of the output. `GET /v1/runs/{id}/outputs/{handle}` returns the full text. The input of a workflow run is never offloaded.
- **Compaction.** Before an LLM call whose context would pass the agent's `context_tokens` limit (default 64,000), old tool outputs are replaced by a stub that names a handle (`out_...`) and the original size. The agent reads one back with `agent_core.read_output`. The estimate comes from the last call's input tokens plus the characters added since, at the tokens-per-character ratio of that call. The oldest outputs go first until the estimate is at most half of the limit, so compaction is rare and keeps the provider's prompt cache. Outputs of the latest assistant turn, outputs of 300 characters or less, and every message of the system, the user and the assistant stay. The event `context.compacted` records what was cleared; the earlier events stay. Reaching `context_tokens` never stops the run. Raising it above the default needs the admin key.
- **Run input.** Everything a human sends to a run goes to `POST /v1/runs/{id}/input` with an `action`: `approve`, `reject`, `outcome_happened`, `outcome_not_happened`, `continue`, `cancel`, `answer` with a `text` (the reply to a run that waits with `"waiting_reason":"input"` or `"escalated"`, after `agent_core.ask_human` or `agent_core.escalate`), or `message` with a `text` that steers the run at its next LLM call. `cancel` also stops a running run before its next step.
- **Unknown outcomes.** When a write's result is lost, the run waits with `"waiting_reason":"unknown_outcome"`. Answer with `outcome_happened`, `outcome_not_happened` or `cancel`.
- **Workflows.** An agent's `workflows` map names fixed step graphs; `POST /v1/runs` with `"workflow":"<name>"` runs one. Steps: `tool` (through the same rule gate and approval as an agent), `approval` (`{ "approved": true|false }`), `llm` (one call, no tools, optional `output_schema`) and `subrun` (a child run of another agent). Values come from `{ "$ref": "$input.text" }` or `{ "$ref": "<step>.<field>" }`; `next` branches with the rule operators. Workflows must be acyclic. The run keeps a copy of the workflow it started with.
- **Connection protection.** A connection takes an optional `limits` block: `calls_per_minute` (default 60) and `concurrency` (default 4), shared by all runs and workers of the tenant. A circuit breaker opens after 5 failed calls in a row, stays open 30 s, then lets one trial call through. A call that must wait is deferred with a `retryAt` (`tool.deferred`); the run neither fails nor waits for a human. After an hour of waiting a call that was never sent gets the tool error `Connection unavailable.`; a write that was sent before waits for a human as an unknown outcome. Registering a connection again without `limits` keeps its limits.
- **Follow-ups.** An agent whose `allow` names `agent_core.schedule_followup` can pause a run with `after_seconds` (60 s to 30 days) and a `note`. The run is `sleeping` until then, survives a restart, and gets the note back when it wakes. At most 10 follow-ups per run.
- **Limits.** An agent's `limits` block bounds LLM calls, tokens, cost per run and per tenant per day, run time, time waiting for a human and tool output size. A breach pauses the run with `"waiting_reason":"limit"`; answer with `continue` (one more allowance) or `cancel`. A wait past `wait_human_s` fails the run.
- **Read cache.** Inside one run, a `read` tool called again with the same arguments is answered from the event log (`tool.cache_hit`, then the same `tool.responded`) while the earlier result is younger than the tool's TTL (default 60 s) and no write to the same connection was sent since. The tool is not called. The loop limit still counts the repeat. Set the TTL, 0 to 3,600 s, with `PATCH /v1/connections/{id}/tools/{tool}` and `{"cache_ttl_s": 120}`; 0 turns the cache off for the tool, and `null` removes the value (back to the default). It needs no `confirm` and is not a review. A webhook connection sets it per tool at registration with `cache_ttl_s` in the tool entry (an MCP server has no standard annotation, so there it is PATCH only). A write to the same connection, an unknown tool, a workflow child run, or a changed output label ends the reuse. `GET /metrics` counts hits in `agent_core_tool_cache_hits_total`.
- **Stream, health and metrics.** `GET /v1/runs/{id}/stream` sends the run's events as server-sent events (`id: <seq>`, `event: <type>`, `data: <event JSON>`); resume with the `Last-Event-ID` header or `?after=<seq>`. The stream closes when the run ends. Use a client that can send the `Authorization` header (not the browser `EventSource`). `GET /readyz` answers 200 when the database and migrations are ready, else 503 with a code and a fix per check. `GET /metrics` serves Prometheus text with run, queue and delivery counts, HTTP and LLM counters; neither needs auth. `pnpm cli log verify <run-id>` (with `AGENT_CORE_URL` and `AGENT_CORE_API_KEY`) recomputes the hash chain of a run's event log: exit 0 intact, 1 broken, 2 unreadable.
- **Doctor and dead letters.** `agent-core doctor` (inside the container: `docker compose exec agent-core agent-core doctor`) reads the service environment and prints one line per check, `ok`, `warn` or `fail` with a fix; it also makes one real call to the default model, and exits 1 when a check fails. A webhook delivery that runs out of retries is `failed`: `GET /v1/deliveries?status=failed` lists your failed deliveries (newest first, `limit` up to 200, no body) and `POST /v1/deliveries/{id}/retry` sends one again from attempt 0. The service deletes `delivered` deliveries after 7 days and `failed` ones after 30 days.
- **Models.** `pnpm models:check` probes each model alias and proposes a profile; `GET /v1/models` shows the profiles.

## Contributing

[AGENTS.md](AGENTS.md) holds the commands, the rules and where to look; [CONTRIBUTING.md](CONTRIBUTING.md) holds the pull request flow.

## License

[MIT](LICENSE)
