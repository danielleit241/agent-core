# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions exist only when the release gate in `ROADMAP.md` passes.

## [Unreleased]

### Removed

- `POST /v1/runs/{id}/resolve` and `POST /v1/runs/{id}/cancel`; use `POST /v1/runs/{id}/input`.

### Changed

- `tool_output_chars` now defaults to 8,000 (was 48,000) and is the offload threshold, not a cut and not a breach. A tenant key may save an agent again with a limit above the default when the value equals the one already stored; a new or raised value still needs the admin key.

### Added

- Read cache within a run: a repeated `read` with the same arguments is answered from the event log (`tool.cache_hit`) while it is younger than the tool's TTL (default 60 s) and no write to the same connection was sent since. `PATCH /v1/connections/{id}/tools/{tool}` accepts `cache_ttl_s` (0 to 3,600) alone, without `confirm`; `GET` shows `cacheTtlS` once set. `/metrics` gains `agent_core_tool_cache_hits_total`.
- Long content is offloaded instead of cut. A tool output, run input, human message or answer longer than the agent's `tool_output_chars` (default now 8,000, was 48,000) is stored whole by content hash. The event and the LLM context hold a preview of about 500 tokens (first 1,200 and last 400 characters, size, and an outline when it is JSON) and a handle `out_...`; `offload` on `tool.responded`, `run.created` (`input`) and `input.received` names it. This is no breach: `limit.reached` is no longer written for `tool_output_chars`. Content above 8,000,000 characters is stored cut. The built-in `agent_core.read_output` (a read, offered once a run holds a handle) searches an output or reads a range of it, and keeps the labels of the output. `GET /v1/runs/{id}/outputs/{handle}` returns the full text. A workflow tool step whose output was offloaded gets the preview as its step output, as the agent loop does (a workflow that needs fields of a large output raises `tool_output_chars` for its agent); the input of a workflow run is not offloaded. NUL bytes and lone surrogates in screened content are replaced by U+FFFD, as in the run store. The shop mock gains a `/warehouse/mcp` endpoint with `reports.sales_export`, and the evals an `ops` agent and the scenario `large-export-find-fact`.
- Secrets are removed before content reaches the event log or the LLM: tool outputs (errors too), run input, human messages and answers. The service removes the connection secrets and URL passwords of the agent, the tenant's webhook secrets and the LLM API key, and 13 kinds of token and key patterns (private keys, AWS, GitHub, Slack, OpenAI, Anthropic, Stripe, Google, JWT, agent-core keys, bearer tokens, URL passwords, `password=` style assignments). Each is replaced by `[REDACTED:<kind>]`. `tool.responded`, `run.created` (`input`) and `input.received` carry `redactions` (kind to count) only when something was removed. `/metrics` gains `agent_core_redactions_total{kind}`.
- Every LLM request is stored by content hash, once per tenant, and `llm.requested` holds the hash of a manifest that lists the parts (`context`). `GET /v1/runs/{id}/llm-calls` shows each call with its parts, the parts new in that call and the characters per role. `GET /v1/runs/{id}/llm-calls/{seq}` returns the messages, tools and output schema of one call.
- The eval report shows input and output tokens, peak context, LLM turns and tool calls per scenario with the change against `baseline.json`, a `sum` line, and `pass@1` and `pass^k` for `--repeat`. `baseline.json` stores these figures (the old string form is not read). Scenarios gain `agent`, `timeoutS`, `expect.peakInputTokensAtMost` and `expect.toolCallCount`. CI appends the table to the step summary.
- `agent-core log verify` also compares the events with the head stored on the run, so deleted tail events are caught. `GET /v1/runs/{id}/events` returns `head`.
- The service stores a check value of the master key and refuses to start with a different key. `agent-core doctor` fails the `master_key` check on a mismatch.
- Without LLM settings the run worker does not start: queued runs stay queued until the service restarts with the settings.
- Setting `AGENT_CORE_ADMIN_KEY` deletes the stored generated admin key hash.
- Roadmap, agent guide, contributing guide, security policy, code of conduct, MIT license.
- M0 walking skeleton: pure core (types, rule gate, runner, projection), Postgres event log with a hash chain, job queue and worker, OpenAI-compatible LLM adapter, MCP tool client, signed outbound webhooks with retries, HTTP Config and Control API, end-to-end refund-with-approval test.
- README quickstart.
- CI on pull requests and `main`, and a nightly run.
- Evals: `pnpm eval` runs shop scenarios against the real service stack, grades them pass or fail (tools called, arguments, final shop state, LLM rubric), and replays a recorded cassette without LLM calls. CI fails when a baseline scenario regresses.
- Runs now carry the requester and the current time (a `volatile` item that replay ignores) in the LLM context.
- The OpenAI-compatible adapter merges adjacent system messages, because some providers keep only the first.
- Fair queue per tenant: a worker claims from the tenant with the fewest running runs, and at most 4 runs per tenant run at once by default.
- Tool safety: discovered tools start strict; MCP hints and `_meta` declarations become a proposal that an admin confirms with `PATCH /v1/connections/{id}/tools/{tool}`. Hints only ever tighten.
- Webhook tools (`"kind":"webhook"` connections): signed calls with an idempotency key, a dry-run header and an HS256 principal JWT.
- `unknown_outcome` runs can be settled (`outcome_happened`, `outcome_not_happened`, `cancel`); `POST /v1/runs/{id}/cancel`; `pending_outcome` in the run view; `run.waiting_human` webhook.
- Model profiles: `GET /v1/models`, `POST /v1/models/check`, `PATCH /v1/models/{alias}`, `pnpm models:check`. Structured output is validated and retried when a model has no strict JSON schema.
- Tool fingerprints: each tool remembers the definition an admin last reviewed. When it changes, the tool shows `changedSinceReview`, its confirmations no longer count, and every call waits for approval, even when an `allow` rule matches, until it is confirmed again. `PATCH` accepts the reviewed `fingerprint` and answers `409 tool_changed` when the tool changed since.
- A run that waits on an unknown outcome records why (`error.raised`, for example `HTTP 503`); `pending_outcome.reason` shows it.
- Every write endpoint accepts `Idempotency-Key`; a key reused with a different request gets 422 `idempotency_key_reused`.
- Tenants: `POST /v1/tenants` creates a tenant and its first API key; `POST /v1/tenants/{id}/keys` issues another key (older keys keep working). Every tenant has its own agents, connections, runs, webhooks and idempotency keys. The admin key works as the tenant `default`.
- Row-level security: the service connects as a login role without table rights and switches to `agentcore_app` or `agentcore_claim` inside each transaction, so the database refuses a query that reaches another tenant's rows.
- Connection and webhook secrets are encrypted at rest (AES-256-GCM, bound to tenant, table and row).
- The admin key may send `X-Tenant-Id` on `/v1/connections` and `/v1/webhooks` routes to act for a tenant.
- Limits: an agent may carry a `limits` block (`llm_calls` 30, `tokens` 500000, `cost_usd` 1, `tenant_cost_usd_per_day` 20, `run_time_s` 1800, `wait_human_s` 86400, `tool_output_chars` 48000 by default). A tenant key may only lower a limit; `403 limit_above_default` otherwise. Every breach appends `limit.reached` with the limit's name. A model without a price and without a provider-reported cost counts as cost 0, so only `tokens` bounds it; give the model profile prices to enforce the cost limits.
- A run that breaches a run limit waits with `"waiting_reason":"limit"`. The resolve action `continue` gives it one more full allowance of that limit (`limit.continued`); `cancel` ends it. Only the admin key may continue past `tenant_cost_usd_per_day` (`403 limit_needs_admin`).
- A run that waits for a human longer than `wait_human_s` (24 hours by default) fails with reason `wait_expired`. This applies to every wait, approvals and unknown outcomes included, which used to wait forever. Waits recorded before this change never expire.
- Workflow runs: an agent may declare `workflows`, each `{ start, steps }` with four step kinds: `tool`, `approval`, `llm` and `subrun`. `POST /v1/runs` takes `workflow`; `run.created` keeps a copy of the definition, so editing the agent does not change a running workflow. Tool steps use the agent's rule gate, approval, retries and connection guard with the call id `step:<stepId>`; an approval step waits like an approval; a rejection is the output `{ "approved": false }`, which a `next` with `when` can branch on, and ends the run as failed when `next` is a plain step id. Arguments take fixed values or `$ref` to the run input or an earlier output; `next` branches on the output with the rule operators. A tool error, a missing `$ref` value or LLM output that misses `output_schema` fails the run. A `subrun` step starts a child agent run (`run.created.parent`), sleeps, and continues with `{ status, text }` when the child ends; a child that did not complete fails the parent unless `next` branches on it. The child inherits the parent's principal, and cancelling the parent cancels its children. Idempotency keys that start with `subrun:` are reserved for child runs (`400 invalid_idempotency_key`). New events `step.started` and `step.completed`. Saving an agent whose workflow has a cycle, a missing step, a `$ref` to no step, a built-in tool step, or an `output_schema` that is unsupported or uses `pattern`, `patternProperties` or `format` gives `422 invalid_workflow`.
- Connection protection: a rate limit (`calls_per_minute`, default 60, fixed one-minute window) and a concurrency limit (`concurrency`, default 4) per connection, set in an optional `limits` block when the connection is registered, and a circuit breaker (opens after 5 failed calls in a row, 30 s open, then one trial call). State lives in Postgres (`connection_guards`, `connection_leases`, migration 009), so all workers share it; a lease of a dead worker expires after 300 s. A call that must wait gets `tool.deferred` with a `retryAt` before it is sent, and the worker puts the job back for that time. Deferral time is not run time. A call deferred for an hour gets the tool error `Connection unavailable.`, unless it is a write that was already sent: that one waits for a human with `unknown_outcome`. Concurrency waits back off 1, 2, 4 ... s, at most 10 s. An error in the guard's own store does not fail the run; the worker tries again. Registering a connection again without `limits` keeps its limits. Built-in tools are not limited.
- Follow-ups: the first built-in tool, `agent_core.schedule_followup`. The model sees it only when an `allow` rule of the agent names it. A call puts the run in the new `sleeping` state until `wakeAt`; the queue job stays due at that time, so a restart does not lose it. On waking the run gets `Follow-up at <time>. Note: <note>` as an `untrusted` tool result and continues. Sleep does not count as run time; a message does not wake the run. At most 10 follow-ups per run. A connection tool named with the prefix `agent_core.` gives `422 reserved_tool_name`.
- Run input: `POST /v1/runs/{id}/input` carries every human action (`approve`, `reject`, `outcome_happened`, `outcome_not_happened`, `continue`, `cancel`) and a `message` that steers the run: it reaches the next LLM request as user text, labelled `untrusted`, and is never lost when it arrives during the final LLM call. `cancel` now also stops a running run, or one that waits for an LLM retry, before its next step (`input.received`, then `cancelled`). A message to an ended run gives `409 run_ended`.
- Loop detection: the `loop` limit (default 3) stops a run before a fourth call with the same tool and the same arguments, and before an LLM call that follows 3 tool turns in a row whose every call and result repeat an earlier one. The run waits with `"waiting_reason":"limit"` and `limit.reached` names `loop`.
- Built-in tools `agent_core.ask_human` and `agent_core.escalate`, on for every agent. `ask_human { question }` makes the run wait with `"waiting_reason":"input"`; `escalate { reason }` makes it wait with `"waiting_reason":"escalated"`. The state event carries the `question` or the agent's reason (`escalation`). New input action `answer` with `text` (1 to 32000 characters): it becomes the tool result of the open call, labelled `untrusted`, and the run continues. Allowed actions for both waits: `answer`, `cancel`. Eval scenario `order-number-missing`; `out-of-scope` now expects `escalated`.
- Self-diagnosis and housekeeping: `agent-core doctor` prints `ok`, `warn` or `fail` per check (`env`, `db`, `migrations`, `runtime_user`, `admin_key`, `master_key`, `llm`, `llm_probe`) with a fix, and exits 1 on any `fail`; it only reads and never creates a key. `GET /v1/deliveries?status=failed` lists the tenant's dead-letter deliveries (newest first, `limit` 50 to 200, no body); `POST /v1/deliveries/{id}/retry` queues a failed delivery again (`409 delivery_not_failed` otherwise). The delivery worker deletes `delivered` rows older than 7 days and `failed` rows older than 30 days, once an hour (migration 010 adds `webhook_deliveries.updated_at`).
- `GET /v1/runs/{id}/stream`: server-sent events of a run (`id` is the seq; resume with `Last-Event-ID` or `?after=`). The stream ends when the run ends. `GET /readyz` (database and migrations) and `GET /metrics` (Prometheus text) need no auth. `agent-core log verify <run-id>` (`pnpm cli log verify`) recomputes the hash chain of a run's log.
- Start without setup: only `DATABASE_URL` and `MIGRATOR_DATABASE_URL` are required. Without `AGENT_CORE_ADMIN_KEY` the service generates an admin key on first start, prints it once and stores only its SHA-256 (`service_settings`). Without `AGENT_CORE_MASTER_KEY` it reads or creates `master.key` in `AGENT_CORE_DATA_DIR` (default `./.data`). Without `LLM_BASE_URL` or `LLM_MODEL_DEFAULT` it still starts: `/readyz` reports `llm_not_configured` and `POST /v1/runs` answers 503.
- A built-in `default` agent (no connections, no tools but the built-ins) serves `POST /v1/runs` when `agent` is left out. The id `default` is reserved (422 `reserved_agent_id`); a `workflow` without `agent` is 422 `agent_required`.

### Changed

- `/readyz` also reports the `llm` and `master_key` checks.

### Fixed

- When the worker stops or loses its lock, an LLM call in progress is aborted at once, so the job is released quickly instead of waiting for the provider timeout.
- A filtered or refused LLM answer now fails the run with reason `filtered` instead of completing it.
- The event log refuses a state change written from a stale status, so a run cancelled while a worker was starting it stays cancelled.
- A tool always runs with the safety computed from its source and confirmations, never a stored copy; tools stored before this change run strict until confirmed.
- A stricter declaration now tightens every safety property, and the output of a tool that reaches outside is always untrusted.
- Registering a connection again no longer overwrites a confirmation made at the same time, and two first registrations get one secret.
- Webhook tool calls carry the idempotency key and dry-run flag in the signed body.
- `models check --apply` keeps the stored prices.
- Strict structured output is used only for schemas a strict provider accepts (every field required); others use validate-and-retry. Structured output together with tools is refused.
- `POST /v1/models/check` probes each model once and in parallel; a failed probe no longer drops the other proposals.
- `PATCH /v1/models/{alias}` and `PATCH /v1/connections/{id}/tools/{tool}` errors name the fields to fix.
- An eval scenario that misses its deadline cancels its run; when the run cannot be stopped, the remaining scenarios are not graded.
- A call that runs again after `outcome_not_happened`, or after an approval, is decided again when its tool changed since review: the earlier `allow` or approval does not cover the changed tool.
- A webhook write that answers 2xx without `{"output": ...}` (for example `204`) waits on an unknown outcome instead of returning an error the model could retry.
- LLM errors in the event log name only the HTTP status; provider text, which can echo part of the API key, is no longer stored.
- `pnpm eval --mode record` keeps the recordings of scenarios that did not run or ended in an error, and `--write-baseline` no longer stores an error as `fail`.
- Eval graders and the rubric transcript count a tool call that the rule gate or a human blocked.
- Registering an MCP connection again at a different URL drops every confirmation, and a tool that is new to an existing connection waits for review, so an `allow` rule does not cover it before an admin has seen it.
- Confirming a tool that shows `changedSinceReview` requires the reviewed `fingerprint` (`428 fingerprint_required` without it).
- A tool that shows `changedSinceReview` is hidden from the model until it is confirmed again, so an unreviewed description never reaches the LLM context. A call made before the change still waits for approval.
- A tool output longer than 48,000 characters is cut in the middle before it is stored and sent to the model, so one large answer cannot fill the LLM context of every later request.
- A resolve built from a stale read of the run log answers `409` instead of attaching the decision to an earlier tool call.
- A write tool that accepts an idempotency key and was interrupted by a crash is called again with the same key, instead of waiting on an unknown outcome.

### Changed

- The waiting reason `needs_input` is now `input`, and `escalated` is new.
- Confirmations stored before tool fingerprints existed no longer count: those tools run strict, behind approval, until confirmed again.
- The runner, not the tool adapters, retries tool calls: reads and writes with an idempotency key get up to 3 attempts with the same key, and each failed attempt is logged as `error.raised`. A keyed write that still fails after it was sent waits on an unknown outcome.
- A transient LLM error (network, timeout, 429, 5xx) no longer fails the run. The run stays `running` and is retried after 30, 60, 120, 240 and 300 seconds (±20%), or longer when the provider's `Retry-After` asks for it (a hint can only lengthen a wait, and no wait is over 5 minutes, so the last wait is 240 to 300 seconds); the sixth failure in a row fails it. `error.raised` gains `retryAt`.
- Source layout: adapters moved from `packages/adapters/*` to `packages/*`.
- The 30-call breaker is now the `llm_calls` limit: the run waits with reason `limit` instead of `breaker`. The tool output cut follows `tool_output_chars` and records `limit.reached`; the run goes on.
- `@agent-core/llm` replaces `llm-openai` and `llm-cassette`; each provider is a folder under `src/providers/`. The eval cassette is imported from `@agent-core/llm/cassette`, so the service does not load it.
- `@agent-core/tools` replaces `tools-mcp` and `tools-webhook`; each tool protocol is a folder under `src/`.
- Tests moved from `src/` to a `tests/` folder in each package that mirrors `src/`.

### Upgrade notes

- **Breaking:** `MIGRATOR_DATABASE_URL` (the owner that runs migrations) and `AGENT_CORE_MASTER_KEY` (32 bytes in base64, for example `openssl rand -base64 32`) are now required. `DATABASE_URL` must name the runtime login role (`agentcore_runtime` in development).
- **Breaking:** PostgreSQL 16 or newer is required.
- **Breaking:** `POST /v1/connections` and `POST /v1/webhooks` need the admin key; a tenant key gets 403. This holds until the SSRF guard exists.
- **Breaking:** recreate existing databases with `docker compose down -v && pnpm db:up`. Plaintext secrets are not migrated, and the `agentcore_runtime` role is created only on a fresh volume.

- After this change, every tool stored earlier (including read tools such as `orders.get`) runs strict and waits for approval. List the tools with `GET /v1/connections/{id}/tools` and confirm each one with `PATCH /v1/connections/{id}/tools/{tool}`, sending the `fingerprint` you reviewed.
