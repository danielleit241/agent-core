# agent-core roadmap

agent-core is an open-source, domain-agnostic **agent service**. A team registers an agent, connects its own systems through standard protocols, and hands work to the agent over an API or a channel. The service owns the harness: the agent loop, tool calls, durable execution, permissions, human approval, security, tracing and evals.

> The service handles the harness. Protocols handle the integration.

This file is the project's plan of record. It says what each milestone delivers, how we know it is done, and what makes a build stable enough to become a version. It changes through pull requests, like code.

- Released versions: none. The project is in development; see [How releases work](#how-releases-work).
- In progress: **M2a — Durable runs and limits**
- License: MIT

## Contents

1. [Product in one page](#product-in-one-page)
2. [Principles](#principles)
3. [Non-goals](#non-goals)
4. [How releases work](#how-releases-work)
5. [Milestone overview](#milestone-overview)
6. [Milestones](#milestones)
7. [Success metrics](#success-metrics)
8. [Security invariants](#security-invariants)
9. [Contributing to the roadmap](#contributing-to-the-roadmap)

---

## Product in one page

**The promise to a team:** "Register an agent, paste the URL of your system, get an API key. The agent starts at the safest level. It earns more autonomy only when the evidence shows it does the work correctly."

### Three protocol gates

Every integration goes through exactly three gates. There is no fourth way in.

| Gate | Direction | Protocols | What the team does |
|---|---|---|---|
| **In** | System → agent | Control API (`POST /v1/runs`, `POST /v1/events`), built-in channels (email, Telegram, schedule) | Hands work to the agent |
| **Tool** | Agent → system | MCP (Streamable HTTP), OpenAPI, signed webhook tools | Lets the agent use its systems |
| **Out** | Agent → system | Signed webhooks, SSE, OpenTelemetry | Receives results, approval requests and traces |

A public **Config API** sits beside the gates. The console uses only public APIs. Anything the console can do, a script can do.

### Four concepts

| Concept | Question it answers | Example |
|---|---|---|
| **Connection** | Which systems can the agent use? | An MCP server URL, an OpenAPI spec, a webhook tool |
| **Channel** | Where does work come from, and where do results go? | The team's app via API, a mailbox, Telegram, a daily schedule |
| **Skill** | How is this job done? | "How we handle refunds", written as plain text |
| **Rule** | What may the agent do alone, and when must it ask? | "Refunds up to 1,000,000 VND need no approval" |

### Three autonomy levels

| Level | What the agent does | Evidence needed to move up |
|---|---|---|
| **Shadow** | Reads real work, looks things up, drafts. Writes and sends nothing | Match rate with what humans actually did |
| **Supervised** | Reads and looks up alone. Every write and every outbound message waits for a human | The service proposes looser rules from the approval history |
| **Autonomous** | Acts within its rules. Asks a human only where a rule says so | The service proposes tighter rules after a rejection |

The service never loosens a rule by itself. It proposes, with numbers, and an `owner` decides.

### Seven faces, one run model

Every face translates into the same run model. A face is a thin adapter, never a second code path. The same is true for every other source of work: channels, triggers, follow-ups, workflow steps and sub-agents all create the same kind of run, and every run goes through the same rule gate.

| Face | Milestone |
|---|---|
| REST (Control API, Config API) | M0 |
| Signed webhooks out | M0 |
| Health (`/healthz`, later `/readyz`, `/metrics`) | M0, M2 |
| OpenAI-compatible Chat Completions | M4 |
| WebSocket and embeddable chat widget | M5 |
| OpenAI-compatible Responses | M5 |
| MCP server (each agent is a tool) | M6 |

### Run lifecycle

The harness is one system, from the moment work comes in to the moment a result goes out. Every run follows the same seven stages. Every stage writes events to the log.

| Stage | What happens | Milestones |
|---|---|---|
| 1. Intake | A face, a channel or a trigger hands work in | M0 (Control API), M3.6 (events), M4.2 (schedule), M4.3 and M5.2 (channels), M4–M6 (chat faces) |
| 2. Normalise | The work becomes a run: principal, input checked against the agent's input schema and labelled `untrusted`, idempotency key | M0, M2.2, M3.2, M3.9 |
| 3. Queue | The run waits for a worker; tenants share workers fairly | M0, M2.3 |
| 4. Load | The worker loads the agent version: instructions, skills, rules, connections, limits | M0, M2.10, M3.5, M6.5, M6.7 |
| 5. Loop | Context → LLM → rule gate → human approval → tool gate, within the run's limits, until the run ends or waits. Every piece of content passes the content pipeline before it enters context | M0, M2.10–M2.13, M2.19–M2.22, M3.3, M6.1, M6.8 |
| 6. Deliver | Results, with a typed `result` when the agent declares an output schema, and approval requests with one-time approval links go out: signed webhooks, SSE, and a reply on the channel the work came from. A policy webhook may check a final answer before it goes out | M0, M2.7, M3.9, M3.10, M4.3, M4.5, M5.2 |
| 7. Evidence | The trace, eval scores with token and cost figures, shadow match rates and the trust ladder show whether the agent did the work correctly | M0, M1, M2.18, M3.11, M5.3, M9 |

### Agent, workflow, extension points

Three parts share one run model. Each has a different job.

| Part | What it decides | What it never does |
|---|---|---|
| **Agent** | The next step, inside its rules | Changes its own rules or autonomy level |
| **Workflow** (M2.4) | A fixed order of steps; a step can be an agent run or a wait for approval | Reasons, or skips the rule gate |
| **Extension points** (policy webhook M4.5, before a tool call and before a final answer; tools built with the SDK M4.1) | Team logic, in the team's own systems | Runs inside the service, or loosens a rule; a timeout or an error counts as `deny` |

### Architecture

Ports and adapters. `packages/core` holds the domain types, ports, rule gate and runner. It imports nothing except `zod` and `node:crypto`, and lint enforces this. Adapters live in `packages/*` (every package except `core` and `protocol`). `apps/service` wires them behind HTTP.

An append-only event log with a hash chain is the single source of truth. Run state is always recomputed from the log, so resuming after a crash means reading the log again.

Stack: TypeScript on Node.js 24 LTS, pnpm workspaces, Zod, Fastify, Vitest, PostgreSQL 17 (also the job queue, via `SKIP LOCKED`), React + Vite for the console, Docker Compose on one machine.

---

## Principles

- **P0. The service handles the harness; protocols handle the integration.** A team does not need to understand harnesses to integrate.
- **P1. The core knows nothing about any domain.** Domain knowledge lives in agent definitions, as data and text.
- **P2. Integrating a system never requires changing the core.**
- **P3. Team code never runs inside the service.** Custom logic stays in the team's systems and is called through the tool gate.
- **P4. Safe by default; loosened by evidence.** Unknown tools are treated as writes that reach outside and return untrusted data.
- **P5. Enforce in code, not in prompts.**
- **P6. Everything is an event.** One event log is the source of truth.
- **P7. Every incident becomes a test scenario.**
- **P8. Show evidence, not only explanations.**
- **P9. The more agent-ready a system is, the shorter its configuration.**
- **P10. The console has no special powers.** It uses the same public APIs as everyone else.

## Non-goals

- A general-purpose agent framework in the style of LangChain.
- Swarms of agents that chat with each other freely.
- Deterministic code replay in the style of Temporal.
- Compliance certification (SOC 2, ISO 27001). The design must not block it.
- Multi-node distributed deployment before `v1.0.0`.
- A built-in metrics dashboard. We export OpenTelemetry to existing tools.
- A drag-and-drop workflow builder in the style of n8n.
- Automatic loosening of rules. Ever.
- Running a public SaaS: no public sign-up, no billing. One installation serves many tenants inside one organisation or one private deployment.
- Uploaded plugins, or sandboxes that run code from teams or users. The one exception is a model-written script in code mode (M6.8): it runs in a sandbox, is off by default, and every tool call in it passes the rule gate.
- Hooks that change content. An extension point returns `allow` or `deny`; it never rewrites tool arguments, tool outputs or answers, because rewritten content would bypass taint tracking.

---

## How releases work

A version is a promise: this build is a stable product that people can run and depend on. A version is never created because a milestone ended, because time passed, or because someone wants a number. It exists only when the evidence below says the product is stable.

### Develop first

- Milestones are **development checkpoints**. Finishing a milestone creates no version and no tag.
- All work lands on `main`. `main` must stay green, but it is not a supported product.
- Until the first release, the project has no version number (`0.0.0` in `package.json`). `CHANGELOG.md` collects every change under `Unreleased`.
- Before the first release, anything may change: the API, the agent definition format, the event types and the database. A breaking change is still marked `BREAKING` in `CHANGELOG.md`, so early users can follow it.

### Release gate

A commit on `main` may be tagged as a version only when **every** item below is true. The gate is a checklist of evidence, not a vote. Nobody, including the maintainer, can skip an item or release on judgement alone. If an item fails, the answer is "not yet", and the work goes back to `main`.

1. **Feature floor.** For the first release (`v0.1.0`): milestones M0–M3 are done (M2 means M2a, M2b and M2c). Without them, runs are not crash-safe, tenants are not isolated, and there is no identity or full rule gate, so the product is not safe to run. For `v1.0.0`: M10 is done.
2. **Green checks.** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db` and `pnpm e2e` pass in CI on the release commit.
3. **Security.** Every security invariant scheduled up to the latest finished milestone has a passing test at 100%.
4. **Contract stability.** No breaking change to the `/v1` API, webhook payloads, event types or agent definition format has landed on `main` in the last 4 weeks.
5. **Soak.** The release candidate has run the full end-to-end suite and the eval suite every day for 14 days with no new failure, and has had no open bug of severity `high` or `critical` during that time.
6. **No blockers.** No open issue carries the `release-blocker` label.
7. **Usable.** The README quickstart works on a clean machine, and an upgrade note exists for anyone who ran an earlier build.
8. **Documented.** `CHANGELOG.md` has a section for the version, and each design decision is recorded (the maintainer keeps ADRs locally in `docs/adr/`).

The path to a version is always through a release candidate. Tag `vX.Y.Z-rc.1` on the commit that passes items 1–4 and 6–8. The 14-day soak (item 5) runs on that candidate. Any fix restarts the soak on a new candidate (`-rc.2`, …). A candidate becomes the version only when it passes the whole gate unchanged.

### After the first release

- Versions follow [Semantic Versioning](https://semver.org/). There is no fixed cadence and no version per milestone. A new minor version ships when features on `main` pass the same gate.
- A patch version (`vX.Y.Z`) carries fixes only. It skips item 1, but item 5 still applies, with a 3-day soak.
- Before `v1.0.0`, a minor version may break compatibility, with a migration note. From `v1.0.0`, the `/v1` API, webhook payloads, event types and agent definition format are stable; breaking them needs `/v2` or a major version.
- Database migrations only go forward. A shipped migration is never edited.

### Definition of done for a milestone

A milestone is done when:

1. Every task meets its "done when" line.
2. All checks pass in CI on `main`.
3. The M0 end-to-end suite still passes, and the milestone added at least one new end-to-end scenario.
4. Every security invariant scheduled for this milestone or an earlier one has a passing test.
5. Each design decision of the milestone has an ADR, and `CHANGELOG.md` lists its changes under `Unreleased`.
6. A short demo script for the milestone exists in `docs/demos/`.

### End-to-end first

1. M0 connects the whole path once: Config API → tool gate (MCP) → LLM → rule gate → human approval → out gate (webhook) → event log. Each part is as rough as it can be while still correct.
2. The M0 end-to-end test runs in every later milestone and must stay green.
3. Each later milestone deepens an existing part or adds a face onto the same run model. No milestone builds a parallel path.

---

## Milestone overview

| Milestone | Theme | Main outcome |
|---|---|---|
| **M0** | Walking skeleton | One real run crosses all three gates, with approval, a signed webhook and a verifiable log |
| M1 | Evals and tools | Scenario evals with replay that needs no LLM; webhook tools; full safety inference |
| M2a | Durable runs and limits | Crash-safe resume, fair queue, workflows, follow-ups, row-level tenant isolation, one limits model, run input, connection protection |
| M2b | Runs out of the box | One-command start with no setup, built-in tools to ask and escalate, SSE, metrics, self-diagnosis |
| M2c | Context that fits | Token and cost figures in evals, content pipeline, offloaded outputs, compaction level 1, read cache |
| M3 | Identity, rules, triggers | Members and roles, principals, full rule gate, run-level taint, agent versions, event triggers |
| | | *Feature floor for `v0.1.0` reached. The version still needs the whole release gate.* |
| M4 | SDK and a second agent | `@agent-core/sdk`, schedules, Telegram, a second agent built with zero commits, OpenAI-compatible chat |
| M5 | Self-serve integration | OpenAPI import, email channel, shadow mode, setup console, WebSocket, widget, Responses API |
| M6 | Context and MCP server | Context budgets, long-term memory, prompt caching, agents exposed as MCP tools, skill selection, soft budgets, tool search, code mode |
| M7 | Data protection | Per-item taint, PII masking, confidential-data routing, attack eval suite |
| M8 | Agent teams | Orchestrator and workers, quarantined sub-agents |
| M9 | Console and trust | Owner and Ops consoles, waterfall trace, fork, trust ladder, OTLP, face-parity tests |
| M10 | Hardening | Handoff, quality bar met, contracts frozen; feature floor for `v1.0.0` |

---

## Milestones

Each task has an ID, a short description and a "done when" line. Only the next milestone has a detailed, step-by-step plan. Later plans are written just before their milestone starts, from what the earlier ones taught us.

### M0 — Walking skeleton

**Goal:** one real run crosses all three gates.

**Scenario:** an agent for a small shop receives "the shirt is faulty, refund order 1042". It looks up the order (a read, allowed). It asks for a refund of 1,200,000 VND, which is above its 1,000,000 VND limit, so the run pauses and a signed `approval.requested` webhook goes out. A human approves through the API. The refund runs, `run.completed` goes out, and the event log verifies.

**Done when:** `pnpm e2e` passes the refund scenarios (over the limit, under the limit, rejected), and `pnpm smoke:live` passes against a real model.

**Scope limits:** one fixed tenant, one admin API key from the environment, `supervised` autonomy only, no console.

- [x] **M0.1** Monorepo, tooling, Docker Compose (Postgres), core import boundary. *Done when:* `pnpm test`, `pnpm typecheck` and `pnpm lint` run; lint fails when core imports an adapter.
- [x] **M0.2** Core types: neutral messages, tools with four safety properties, events, run states, ports. *Done when:* schema tests pass.
- [x] **M0.3** Postgres store: migrations, append-only event log with a hash chain, `verifyChain`. *Done when:* write, read and tamper-detection tests pass.
- [x] **M0.4** OpenAI-compatible LLM adapter and a scripted fake LLM server. *Done when:* the adapter reads text, tool calls and usage correctly from the fake server.
- [x] **M0.5** MCP client (Streamable HTTP), safety inference from MCP annotations, mock shop MCP server. *Done when:* it lists and calls the shop tools, and infers safety per the defaults table.
- [x] **M0.6** Minimal rule gate. *Done when:* the decision table tests pass.
- [x] **M0.7** Runner: agent loop, events, pause at `waiting_human`, continue after resolve, 30-call breaker, crash recovery. *Done when:* runner tests with fake ports pass.
- [x] **M0.8** Job queue and worker. *Done when:* a worker claims and runs a job, and two workers never claim the same job.
- [x] **M0.9** Signed outbound webhooks with retries; `verifyWebhook`. *Done when:* signature and retry tests pass.
- [x] **M0.10** HTTP service: minimal Config and Control APIs, `/healthz`, API-key auth. *Done when:* HTTP tests pass.
- [x] **M0.11** End-to-end test and live smoke test. *Done when:* `pnpm e2e` and `pnpm smoke:live` pass.
- [x] **M0.12** README quickstart, ADRs 0001–0004, M0 learning note. *Done when:* a newcomer can follow the README and reproduce the demo.
- [x] **M0.13** Continuous integration: a CI workflow runs every check on each pull request and on `main`; community files are updated with the real commands. *Done when:* CI is green on `main`. No version is tagged.

### M1 — Evals and tools

**Goal:** we can measure whether an agent is right, and replay a run without calling the LLM.

- [x] **M1.1** Eval scenario format; load shop fixtures before each scenario. *Done when:* a scenario runs alone and repeats with the same result.
- [x] **M1.2** Graders: tools called, arguments, final state; LLM rubric grader. A scenario passes only when every check passes; a group's score is the share of its scenarios that pass. *Done when:* the eval command prints a score per group.
- [x] **M1.3** The first 10 scenarios for the shop agent. *Done when:* a baseline score exists.
- [x] **M1.4** Record and replay with a normalised request hash; `volatile` context items. *Done when:* replay gives the same score without LLM calls, and a changed timestamp does not break replay.
- [x] **M1.5** Webhook tools (the third tool protocol). *Done when:* the service calls a signed webhook tool that receives a principal JWT (HS256, signed with the connection's secret, valid for 5 minutes, `aud` is the connection).
- [x] **M1.6** Full inference of the four safety properties; API to confirm them. *Done when:* hints only ever make a tool stricter; loosening needs confirmation.
- [x] **M1.7** Model capability profiles and `models check`. *Done when:* for a model without strict JSON schema, the service validates and retries.
- [x] **M1.8** API to settle an `unknown_outcome` run. *Done when:* a human can mark the interrupted write as done, as not done (call it again), or cancel the run; the run continues or ends.

### M2a — Durable runs and limits

**Goal:** runs survive restarts, tenants cannot see each other, and every run stays within its limits without overloading a team's systems.

- [x] **M2.1** Resume from the event log; full resume and retry table. *Done when:* killing a run mid-way never repeats a completed tool call, and repeats an interrupted one only with the same idempotency key; a write without an idempotency key goes to `unknown_outcome`.
- [x] **M2.2** Full idempotency for inbound work and tool calls. *Done when:* a repeated `Idempotency-Key` returns the original run.
- [x] **M2.3** Fair queue per tenant; concurrency limits. *Done when:* one busy tenant does not block another.
- [ ] **M2.4** Workflow runs (four step types, branching with fixed operators). *Done when:* a sample workflow runs, waits for approval and continues.
- [ ] **M2.5** Follow-ups and the `sleeping` state. *Done when:* a follow-up wakes on time, including after a restart.
- [x] **M2.6** Tenants, row-level security with `FORCE`, three database roles, two-tenant tests; encrypted secrets. *Done when:* invariant B6 passes.
- [ ] **M2.10** One limits model. Every limit lives in one `limits` block of the agent, and each has a safe default: LLM calls, tokens and cost per run, cost per tenant per day, wall-clock time per run, time a run may wait for a human, tool output size. A breach appends `limit.reached` with the name of the limit. A running run moves to `waiting_human` with reason `limit`, where a human may let it continue once or cancel it; a run that waits too long for a human fails with reason `wait_expired`. Only an `owner` may set a limit above its default. *Done when:* a test breaches each limit and gets the same event; the 30-call breaker from M0 becomes the `llm_calls` limit.
- [ ] **M2.11** Run input. One path carries everything a human sends to a run: `cancel`, also while the run is `running` or waits for an LLM retry; a message that steers a running run; the answer to `agent_core.ask_human`; and the existing approval and outcome actions. The runner reads new input before each step. *Done when:* a running run is cancelled before its next step, and a steering message reaches the next LLM request.
- [ ] **M2.12** Connection protection: a rate limit and a concurrency limit per connection, shared by all runs and workers, and a circuit breaker that opens after repeated failures. A run that hits a limit or an open breaker waits with a `retryAt`; it does not fail. *Done when:* 50 parallel runs never exceed a connection's limits, and an open breaker sends no call until it half-opens.
- [ ] **M2.13** Loop detection (was M9.4). The same tool with the same arguments called N times, or K LLM turns that add no new tool result, is a breach of the `loop` limit. *Done when:* a looping scenario moves to `waiting_human` with reason `limit`, and the event names `loop`.
- [x] **M2.14** Stop reasons. An answer that the provider filters or refuses never counts as `completed`. *Done when:* a `content_filter` response fails the run with reason `filtered`.

### M2b — Runs out of the box

**Goal:** the service starts and does useful work with one command and no setup, and it says what is missing.

- [ ] **M2.7** SSE, `/readyz`, `/metrics`, `log verify` in the CLI. *Done when:* a client receives live events and Prometheus reads metrics.
- [ ] **M2.9** One-command deployment: the whole service starts with `docker compose up`. *Done when:* metric S4 passes on a clean machine.
- [ ] **M2.15** Start without setup. Without `AGENT_CORE_ADMIN_KEY`, the service generates an admin key on first start, shows it once and stores only its hash. Without LLM settings, the service starts and `/readyz` reports `llm_not_configured`. A built-in default agent (no connections, `supervised`) serves `POST /v1/runs` when no agent is named. *Done when:* `docker compose up` with an empty `.env` gives a working API, and LLM settings are the only step before the first run.
- [ ] **M2.16** Built-in tools to end a run well. `agent_core.ask_human` waits with reason `input` until an answer arrives (M2.11). `agent_core.escalate` waits with reason `escalated` and records the agent's reason. Built-in tools have the four safety properties and pass the rule gate; no connection may use the `agent_core.` prefix. *Done when:* a scenario with a missing order number ends in `input`, and an out-of-scope scenario ends in `escalated`.
- [ ] **M2.17** Self-diagnosis and housekeeping. `agent-core doctor` and `/readyz` name each missing or broken setting and its fix. Old webhook deliveries are cleaned up; a delivery that runs out of retries goes to a dead-letter list that the API can read and resend. A worker releases its jobs on SIGTERM. *Done when:* each check in `doctor` has a test, and a stopped worker leaves no job locked.

### M2c — Context that fits

**Goal:** every LLM request carries only what the step needs, and the evals prove it.

- [ ] **M2.8** Content-addressed context snapshots. *Done when:* each LLM call has a snapshot and repeated parts are stored once.
- [ ] **M2.18** Measure first. The eval report shows tokens, LLM turns, tool calls and cost per scenario, and pass^k for `--repeat k`. *Done when:* the baseline holds these figures and CI prints the change against it.
- [ ] **M2.19** Content pipeline. All content that enters LLM context (tool outputs, script outputs, cached reads, run input) passes one ordered stage: label, remove secrets, mask PII when the agent asks for it (M7.2), offload when large. *Done when:* a tool output with a known secret pattern reaches neither an LLM request nor the event log.
- [ ] **M2.20** Offloaded outputs. An output above the threshold is stored once by content hash (M2.8); context holds a preview and a handle. The built-in `agent_core.read_output` reads a range of it or searches it; it is a read, passes the rule gate and keeps the output's labels. This replaces the 48,000-character cut. *Done when:* a 1 MB output adds at most 2,000 tokens to context, and the agent still finds a fact in its middle.
- [ ] **M2.21** Compaction, level 1. When the `usage.inputTokens` of the last LLM call passes the threshold, old tool outputs are replaced by a stub, and a `context.compacted` event records which ones. System instructions, the run input, pending tool calls and open approvals are never compacted. *Done when:* a 100-step scenario stays under the threshold and its score does not drop.
- [ ] **M2.22** Read cache within a run. A `read` with the same tool and arguments returns the earlier result while it is younger than its TTL (default 60 s); a write to the same connection clears the cache; a tool can opt out. A cache hit is an event. *Done when:* repeated reads in a scenario call the tool once, and a read after a write calls it again.

### M3 — Identity, rules, triggers

**Goal:** the agent acts on behalf of a known person, under rules that code enforces.

- [ ] **M3.1** Members, roles, console sign-in, API keys scoped to an environment and a role set. *Done when:* a key can only claim roles it was granted.
- [ ] **M3.2** Principals: the principal JWT from M1.5 is sent with every tool call, MCP included; `scope` rules. *Done when:* invariant B1 passes.
- [ ] **M3.3** Full rule gate (allow, require approval, deny, fixed operators); `autonomous` level. *Done when:* the decision table tests pass.
- [ ] **M3.4** Run-level taint tracking. *Done when:* invariant B2 (run level) passes.
- [ ] **M3.5** Agent versions: draft, publish, environments, YAML export and import. A version holds instructions, named skills, rules and connections. *Done when:* each run records the version and the skills it loaded; invariant B9 passes.
- [ ] **M3.6** Event triggers: `POST /v1/events`, signed inbound webhooks, filters, debounce, rate limits. *Done when:* a storm of 10,000 events stays within budget.
- [ ] **M3.7** SSRF guard and per-tenant host allow-list; no secrets in logs. *Done when:* invariants B3, B10 and B11 pass.
- [ ] **M3.8** API-only end-to-end journey, extended from M0. *Done when:* metric S7 passes.
- [ ] **M3.9** Typed run contract: an agent version may declare an input schema and an output schema, in a strict subset of JSON Schema. `POST /v1/runs` checks `input.data` against the input schema and labels it `untrusted`, like the text. The model returns the result through the built-in tool `agent_core.submit_result`, which passes the rule gate like any other tool; by default a result counts as a decision the team will act on, so under `supervised` it waits for approval unless an `allow` rule matches. The API and webhooks return it as `result` beside the text `output`. *Done when:* a result that is invalid, missing or rejected goes back to the model at most twice and then the run fails; an `allow` rule on result fields lets a result through; and the refund scenario returns a `result` that matches its schema.
- [ ] **M3.10** One-time approval links and `amend`. The `approval.requested` webhook carries a link that works once, expires with the wait, and is bound to the tool call and its arguments. Opening the link never acts; only a confirmation does. The token is never stored or logged, no read endpoint returns the link, and only an `owner` can change a webhook that receives links. A tenant can require sign-in as one of the agent's approvers. `resolve` accepts `amend` with new arguments, which the rule gate checks again. *Done when:* a link fails after use, after expiry and after the request changes; fetching the link does not approve; the token appears in no event, table or log; the event log records that the approval came through a link; and an amended call that the rules deny is refused while the run keeps waiting.
- [ ] **M3.11** Evals from evidence (P7). One command turns the trace of a run into a draft scenario. Publishing an agent version shows its eval scores, tokens and cost against the current version on the same scenarios. *Done when:* a failed run becomes a passing regression scenario after its fix, and a publish shows the score change.

### M4 — SDK and a second agent

**Goal:** prove the core is domain-agnostic. A second agent in a different domain runs with zero commits to agent-core.

- [ ] **M4.1** `@agent-core/sdk`: `tool`, `serveMcp`, `serveWebhookTools`, `AgentCore` client, `verifyWebhook`. *Done when:* a mock price feed built with the SDK works.
- [ ] **M4.2** Schedule triggers. *Done when:* runs start on a cron schedule in the right time zone.
- [ ] **M4.3** Telegram channel (in and out, `chat_id` allow-list). *Done when:* it receives and sends messages.
- [ ] **M4.4** Second agent, `daily-brief`, built only through the Config API in a second tenant. *Done when:* it runs with zero commits for it.
- [ ] **M4.5** Policy webhook with two checkpoints: before a tool call, and before a final answer or `result` goes out. It returns `allow` or `deny` with a reason, never new content. *Done when:* a timeout or an error counts as `deny`; a denied final answer goes back to the model at most twice, and then the run waits with reason `escalated`.
- [ ] **M4.6** `POST /v1/openai/chat/completions` with streaming; client-sent tools are ignored. *Done when:* Open WebUI can chat with the shop agent.

### M5 — Self-serve integration

**Goal:** a new team integrates a system in one working day, without help.

- [ ] **M5.1** OpenAPI importer; endpoint selection; connection type detected from the URL. *Done when:* pasting a URL produces a tool list.
- [ ] **M5.2** Simulated email channel; identity mapping. *Done when:* an inbound email gets a reply in the same thread.
- [ ] **M5.3** Shadow mode: dry-run or intent logging; human outcome capture; automatic match scoring and a review queue. *Done when:* invariant B8 passes and the match rate is computed.
- [ ] **M5.4** Setup console (work list, connections, rules as forms, keys, webhooks, integration guide). *Done when:* a new team finishes integration using only the console.
- [ ] **M5.5** WebSocket `/v1/ws`, `POST /v1/client-tokens`, CORS per registered origin. *Done when:* real-time chat works and reconnects from `last_event_id`.
- [ ] **M5.6** Embeddable chat widget. *Done when:* it embeds in a sample page and chats.
- [ ] **M5.7** `POST /v1/openai/responses` with `previous_response_id`. *Done when:* a Responses client holds a multi-turn conversation.

### M6 — Context and MCP server

**Goal:** long conversations stay within budget, and any MCP client can use an agent.

- [ ] **M6.1** Token budget for context; compaction, level 2: a summary in a fixed schema (confirmed facts, decisions, open work, key IDs) that keeps the labels of the content it replaces and is recorded in the cassette like any LLM call. *Done when:* a 200-turn conversation stays within budget, and a scenario that needs an early fact still passes after compaction.
- [ ] **M6.2** Long-term memory per principal; retrieval. *Done when:* the agent remembers a customer across threads.
- [ ] **M6.3** Prompt caching where the provider supports it. *Done when:* cost drops measurably.
- [ ] **M6.4** MCP server at `/v1/mcp`: each agent is a tool; `get_run` and `resolve`; OAuth or API-key auth. *Done when:* Claude Desktop can call the shop agent.
- [ ] **M6.5** Skill selection: a run loads only the skills that match its work; the trace shows which skills were loaded and why. *Done when:* an agent with 20 skills loads only the relevant ones, and its eval score does not drop.
- [ ] **M6.6** Soft budget and a model per step. At 80% of a run's cost limit (M2.10), the model is told and the run moves to a cheaper model alias. An agent may name one alias for tool steps and another for the final answer and summaries. The cassette records each alias. *Done when:* cost per scenario drops against the M2.18 baseline and the score does not drop.
- [ ] **M6.7** Tool search. When an agent has more tools than a threshold, the model sees only their names and short descriptions, and the built-in `agent_core.find_tools` loads full schemas. Loaded tools go at the end of the tool list, so the cached prompt prefix stays valid. *Done when:* an agent with 200 tools picks the right tools in its scenarios, with fewer input tokens than with every schema loaded.
- [ ] **M6.8** Code mode. The built-in `agent_core.run_script` runs a model-written JavaScript script in a sandbox with no network, no file system, and limits on CPU, memory and time. Every tool call in the script returns to the runner and passes the rule gate, the content pipeline and the event log like any other call. Each agent has a mode: `off` (default), `on` or `yolo`. In `on`, a write that needs approval ends the script and becomes an ordinary tool call that waits for approval. `yolo` skips approval only: deny rules and every invariant still apply, only an `owner` can turn it on, and only at the `autonomous` level. *Done when:* a scenario with many reads uses fewer LLM turns and tokens than without code mode at the same score, and invariant B12 passes.

### M7 — Data protection

**Goal:** untrusted input cannot make the agent leak data.

- [ ] **M7.1** Per-item taint tracking. *Done when:* invariant B2 (full) passes.
- [ ] **M7.2** PII masking in traces by role, and, when the agent asks for it, before content reaches the LLM (content pipeline, M2.19); sample PII set. *Done when:* invariant B4 passes.
- [ ] **M7.3** Model routing by the `confidential` label. *Done when:* invariant B5 passes.
- [ ] **M7.4** Attack eval suite (prompt injection, data exfiltration, tool misuse). *Done when:* the suite passes.

### M8 — Agent teams

**Goal:** split work across agents without widening anyone's permissions.

- [ ] **M8.1** Orchestrator and workers: a sub-agent is a tool, permissions only narrow, depth at most 3. *Done when:* the trace shows the parent–child tree.
- [ ] **M8.2** Quarantined sub-agent with a strict schema; only enum, number, boolean and narrow-pattern fields may lower a label. *Done when:* a malicious email cannot leak data.
- [ ] **M8.3** The shop agent uses quarantine. *Done when:* ordinary email replies no longer need approval.

### M9 — Console and trust

**Goal:** owners and operators see everything the agent did and decide with evidence.

- [ ] **M9.1** Owner console (decisions to make, activity log, comparisons, proposals). *Done when:* it matches the approved mockups.
- [ ] **M9.2** Ops console (health, runs, grouped errors, waterfall trace, step inspector). *Done when:* it matches the approved mockups.
- [ ] **M9.3** Fork a run from the `seq` of an `llm.requested` event. *Done when:* the fork runs as a dry-run after the fork point.
- **M9.4** Moved to M2.13 (loop detection) and M2.10 (limits).
- [ ] **M9.5** Trust ladder: task groups, proposals to loosen and to tighten. *Done when:* proposals appear under the right conditions and only an `owner` can accept them.
- [ ] **M9.6** OTLP export; external anchor for the hash chain. *Done when:* traces show in Langfuse or Jaeger.
- [ ] **M9.7** Agent health; `connection.unhealthy` and `agent.degraded` webhooks. *Done when:* a broken connection raises an alert.
- [ ] **M9.8** Face-parity tests; eval regression in CI; `webhooks listen`. *Done when:* the same scenario gives the same result over REST, WebSocket, OpenAI-compatible and MCP.

### M10 — Hardening

**Goal:** contracts that teams can depend on. Feature floor for `v1.0.0`.

- [ ] **M10.1** Handoff between agents. *Done when:* a scenario that hands work from one agent to another passes.
- [ ] **M10.2** Raise the shop agent to at least 90% on functional evals. *Done when:* metric S2 passes.
- [ ] **M10.3** Freeze `/v1`, webhook payloads, event types and the agent definition format; publish the OpenAPI document. *Done when:* a contract test fails on any breaking change.
- [ ] **M10.4** Review metrics S1–S7 and invariants B1–B11; publish the report. *Done when:* every metric and invariant has evidence in the report.

### Later (after `v1.0.0`, not scheduled)

Batch triggers, crypto-shredding for the right to erasure, Zalo channel, Git sync for agent definitions, multi-node deployment, fallback to another model when a provider is down.

---

## Success metrics

| ID | Metric | Checked from |
|---|---|---|
| S1 | A new team integrates one system in at most one working day, with zero commits to agent-core | M5 |
| S2 | The shop agent passes at least 90% of functional eval scenarios | M10 |
| S3 | Security invariants pass at 100% | every milestone |
| S4 | The whole service runs on one machine with one command | M2 |
| S5 | Cost and latency of every run are measured and shown in the console | M9 |
| S6 | From tenant creation to the first API result in at most 15 minutes | M5 |
| S7 | The end-to-end journey (create agent, connect tools, submit work, approve, receive webhook) works using only the API, with an automated test | M0 (single tenant), M3 (full) |

## Security invariants

Each invariant is an automated test. From the milestone that introduces it, it must pass at 100% in every later milestone and in every version.

| ID | Invariant | From |
|---|---|---|
| B1 | Principal A cannot read data that belongs to principal B through any tool | M3 |
| B2 | No tool that reaches outside sends to an unauthorised recipient when the run holds both `untrusted` and `internal` data, unless a human approved it | M3 (run level), M7 (per item) |
| B3 | No secret appears in context, traces or logs | M3 |
| B4 | No unmasked PII appears in a readable trace, measured on the sample PII set | M7 |
| B5 | `confidential` data is never sent to a model alias other than `private` | M7 |
| B6 | No data of one tenant is readable from another tenant, through the API or through a run | M2 |
| B7 | Editing or deleting a row of the event log makes chain verification fail | M0 |
| B8 | In shadow mode, no `write` or outward-reaching tool runs for real | M5 |
| B9 | No rule or autonomy level changes without an `owner` doing it | M3 |
| B10 | A webhook without a valid signature, or with a timestamp more than 5 minutes off, is rejected | M0 |
| B11 | The service calls no host outside the tenant's allow-list | M3 |
| B12 | A tool call made from a code-mode script never bypasses a deny rule, and in `yolo` mode a call that reaches outside still needs approval whenever B2 applies | M6 |

Report suspected security issues privately, as `SECURITY.md` describes. Do not open a public issue.

---

## Contributing to the roadmap

- **Pick a task:** comment on the task's issue, or open one titled with the task ID (for example `M1.4: record and replay`). One pull request per task is the norm.
- **Propose a change to the plan:** open a pull request that edits this file. Say which milestone it affects and why. Explain the reason for a change of direction in the pull request.
- **Propose a new feature:** open an issue first. Say which principle it serves and which non-goal it does not break.
- **Status:** a task's box is ticked in the same pull request that meets its "done when" line.

See `AGENTS.md` for the commands, conventions and boundaries that apply to every change, made by a person or by a coding agent.
