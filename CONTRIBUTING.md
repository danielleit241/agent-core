# Contributing

Thanks for helping.

1. Read [AGENTS.md](AGENTS.md) for the commands and rules.
2. Pick a task from [ROADMAP.md](ROADMAP.md), or open an issue first for a new idea.
3. Branch from `main`, write a failing test, make it pass.
4. Run `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm db:up && pnpm test:db && pnpm e2e` when you touch storage, the service or the flow. CI runs all of them on every pull request. Then open a pull request titled with the task ID, for example `M0.6: minimal rule gate`.

Security problems: do not open an issue; see [SECURITY.md](SECURITY.md).

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
