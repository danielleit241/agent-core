# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions exist only when the release gate in `ROADMAP.md` passes.

## [Unreleased]

### Added

- Roadmap, agent guide, contributing guide, security policy, code of conduct, MIT license.
- M0 walking skeleton: pure core (types, rule gate, runner, projection), Postgres event log with a hash chain, job queue and worker, OpenAI-compatible LLM adapter, MCP tool client, signed outbound webhooks with retries, HTTP Config and Control API, end-to-end refund-with-approval test.
- README quickstart.
- CI on pull requests and `main`, and a nightly run.
- Evals: `pnpm eval` runs shop scenarios against the real service stack, grades them pass or fail (tools called, arguments, final shop state, LLM rubric), and replays a recorded cassette without LLM calls. CI fails when a baseline scenario regresses.
- Runs now carry the requester and the current time (a `volatile` item that replay ignores) in the LLM context.
- The OpenAI-compatible adapter merges adjacent system messages, because some providers keep only the first.
- Tool safety: discovered tools start strict; MCP hints and `_meta` declarations become a proposal that an admin confirms with `PATCH /v1/connections/{id}/tools/{tool}`. Hints only ever tighten.
- Webhook tools (`"kind":"webhook"` connections): signed calls with an idempotency key, a dry-run header and an HS256 principal JWT.
- `unknown_outcome` runs can be settled (`outcome_happened`, `outcome_not_happened`, `cancel`); `POST /v1/runs/{id}/cancel`; `pending_outcome` in the run view; `run.waiting_human` webhook.
- Model profiles: `GET /v1/models`, `POST /v1/models/check`, `PATCH /v1/models/{alias}`, `pnpm models:check`. Structured output is validated and retried when a model has no strict JSON schema.
- Tool fingerprints: each tool remembers the definition an admin last reviewed. When it changes, the tool shows `changedSinceReview`, its confirmations no longer count, and every call waits for approval, even when an `allow` rule matches, until it is confirmed again. `PATCH` accepts the reviewed `fingerprint` and answers `409 tool_changed` when the tool changed since.
- A run that waits on an unknown outcome records why (`error.raised`, for example `HTTP 503`); `pending_outcome.reason` shows it.

### Fixed

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

### Changed

- Confirmations stored before tool fingerprints existed no longer count: those tools run strict, behind approval, until confirmed again.

### Upgrade notes

- After this change, every tool stored earlier (including read tools such as `orders.get`) runs strict and waits for approval. List the tools with `GET /v1/connections/{id}/tools` and confirm each one with `PATCH /v1/connections/{id}/tools/{tool}`, sending the `fingerprint` you reviewed.
