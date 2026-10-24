# AGENTS.md

Basic context for anyone, person or coding agent, changing agent-core.

## Project

agent-core is an agent service. Teams connect systems through three gates (in: Control API; tool: MCP, OpenAPI, webhook tools; out: signed webhooks). The service runs the harness: agent loop, tool calls, rules, approval, event log.

Status: in development. Current milestone: M0 (see `ROADMAP.md`). Until M0.1 lands, the commands below do not exist yet.

## Where to look

- `ROADMAP.md`: milestones, tasks, release gate, security invariants.

## Commands

```bash
pnpm install && pnpm db:up   # setup (Node 24, pnpm 10, Docker)
pnpm lint && pnpm typecheck  # before every commit
pnpm test                    # unit tests
pnpm test:db                 # tests that need Postgres (*.db.test.ts)
pnpm e2e                     # end-to-end; must always stay green
```

## Rules

- `packages/core` imports only `zod`, `node:crypto` and itself. Adapters live in `packages/adapters/*`.
- The event log is the source of truth. Append only; recompute state from events.
- Unknown tools are treated as writes that reach outside. Code never loosens a rule by itself.
- No team code runs inside the service. No new integration paths beyond the three gates.
- Test first. Never change an assertion just to make a test pass. Tests use fakes, never real networks or models.
- No secrets in code, logs, events or LLM context.
- English for code, docs and commits. Conventional Commits. One task per pull request.
- Never tag or bump a version; versions come only from the release gate.

## Stop and ask when

The roadmap and the code disagree; a decision is not settled by the roadmap; or a step needs a credential you do not have. Never fake a result.
