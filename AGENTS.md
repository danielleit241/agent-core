# AGENTS.md

Basic context for anyone, person or coding agent, changing agent-core.

## Project

agent-core is an agent service. Teams connect systems through three gates (in: Control API; tool: MCP, OpenAPI, webhook tools; out: signed webhooks). The service runs the harness: agent loop, tool calls, rules, approval, event log.

Status: in development. `ROADMAP.md` holds the milestones and the one in progress.

## Where to look

- `ROADMAP.md`: milestones, tasks, release gate, security invariants.

## Commands

```bash
pnpm install && pnpm db:up   # setup (Node 24, pnpm 10, Docker)
pnpm lint && pnpm typecheck  # before every commit
pnpm test                    # unit tests
pnpm test:db                 # tests that need Postgres (*.db.test.ts)
pnpm e2e                     # end-to-end; must always stay green
pnpm eval                    # eval scenarios replayed from the cassette; no LLM calls
pnpm models:check            # probe the configured models (needs a running service and LLM_*)
```

## Rules

- `packages/core` imports only `zod`, `node:crypto` and itself. Adapters live in `packages/*` (every package except `core` and `protocol`).
- Library packages never depend on apps or mocks at runtime. An adapter depends only on `core`, `protocol` and third-party libraries. `packages/protocol` holds the signed wire formats and imports only `node:crypto`. `workspace.test.ts` checks this.
- Inside a package, `src/` is grouped by responsibility (for example `events/`, `policy/`, `runner/`); a small package stays flat. Tests live in the package's `tests/` folder, which mirrors `src/`: `*.test.ts` (unit), `*.db.test.ts` (needs Postgres); end-to-end tests live in `e2e/`.
- The event log is the source of truth. Append only; recompute state from events.
- Unknown tools are treated as writes that reach outside. Code never loosens a rule by itself.
- No team code runs inside the service. No new integration paths beyond the three gates.
- Test first. Never change an assertion just to make a test pass. Tests use fakes, never real networks or models.
- No secrets in code, logs, events or LLM context.
- English for code, docs and commits. Conventional Commits. One task per pull request.
- Never tag or bump a version; versions come only from the release gate.

## Stop and ask when

The roadmap and the code disagree; a decision is not settled by the roadmap; or a step needs a credential you do not have. Never fake a result.
