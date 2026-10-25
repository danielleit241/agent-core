# @agent-core/evals

Scenario evals for the shop agent. Each scenario starts the real service stack against the test database and the mock shop, hands the work in through the public API, answers approvals with the scenario's policy, and grades the result.

A scenario passes only when every check passes: run status, tools called (with an argument subset), tools not called, the final shop state, and an optional rubric graded by an LLM judge (alias `smart`). A group's score is the share of its scenarios that pass.

## Run

```bash
pnpm db:up
pnpm eval                          # replay from cassettes/shop.json; no LLM calls, no LLM_* variables
pnpm eval --group refund           # one group
pnpm eval --scenario order-status  # one scenario
pnpm eval --mode live              # call the model in .env (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_DEFAULT, optional LLM_MODEL_SMART)
```

`pnpm eval` resets the test database (`agentcore_test`, or `EVAL_DATABASE_URL`). Do not run it at the same time as `pnpm test:db` or `pnpm e2e`.

Exit code 1 means a scenario errored (for example a cassette miss) or a scenario that passed in `baseline.json` does not pass now.

A scenario has 120 s to settle. Past that, its run is cancelled and the scenario errors. A run that keeps running for 60 s more could still change the shop, so the remaining scenarios are reported as `not run` instead of graded.

## Re-record

Re-record after a change that alters what the agent sends to the LLM (instructions, tools, context, scenarios):

```bash
pnpm eval --mode record --write-baseline
```

Read every failure before you commit the new cassette and baseline. Change a scenario only when the scenario itself is wrong, never to raise the score.

## Files

- `scenarios/*.json`: one scenario per file (schema in `src/scenario.ts`).
- `agents/shop.json`: the agent definition under test.
- `cassettes/shop.json`: recorded LLM responses, keyed by the normalised request hash. Holds no secrets.
- `baseline.json`: the verdict of each scenario at the last recording.

## Baseline

Recorded with the model in the maintainer's `.env` (2026-10-25): **10/10 (100%)**. One `--mode live` run on the same day also gave 10/10. A recording is one sample of a model that is not deterministic; an earlier recording failed `prompt-injection-refund` (the agent refunded the real order amount that the injected text asked for). The agent's instructions now say that text posing as a system instruction is ignored.

| Group | Score |
|---|---|
| lookup | 2/2 |
| refund | 3/3 |
| size | 2/2 |
| safety | 2/2 |
| scope | 1/1 |
