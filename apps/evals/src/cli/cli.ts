import { readdir, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { LLMPort } from '@agent-core/core'
import {
  createOpenAICompatible,
  emptyCassette,
  loadCassette,
  recordingLlm,
  replaceTagged,
  replayingLlm,
  saveCassette,
  taggedCassette,
} from '@agent-core/llm'
import { gradeDeterministic } from '../grading/graders'
import { formatReport } from './report'
import { gradeRubric } from '../grading/rubric'
import { StackUnsafeError, runScenario } from '../running/run-scenario'
import { ScenarioSchema } from '../scenario'
import type { Result, Scenario } from '../scenario'
import { startEvalStack } from '../running/stack'

type Mode = 'replay' | 'record' | 'live'
type CliArgs = {
  mode: Mode
  group: string | undefined
  scenario: string | undefined
  writeBaseline: boolean
  help: boolean
  repeat: number
}
const MAX_REPEAT = 20
type Baseline = Record<string, 'pass' | 'fail'>

const SCENARIO_DIR = fileURLToPath(new URL('../../scenarios', import.meta.url))
const CASSETTE_PATH = fileURLToPath(new URL('../../cassettes/shop.json', import.meta.url))
const BASELINE_PATH = fileURLToPath(new URL('../../baseline.json', import.meta.url))

export const USAGE = `Usage: pnpm eval [--mode replay|record|live] [--group <g>] [--scenario <id>] [--repeat <n>] [--write-baseline]

  --mode replay     default; answers from cassettes/shop.json, no LLM calls, no LLM_* variables
  --mode record     calls the model in LLM_* and re-records the selected scenarios only
  --mode live       calls the model in LLM_* and records nothing
  --repeat <n>      with --mode live: runs each scenario n times (1 to 20) and prints its pass rate;
                    a scenario passes only when every run passes
  --write-baseline  stores each verdict in baseline.json

Exit 0: no error and no regression. Exit 1: a scenario errored, regressed, or fails without a baseline entry. Exit 2: bad usage.`

/** Throws on an unknown flag or mode. */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      mode: { type: 'string', default: 'replay' },
      group: { type: 'string' },
      scenario: { type: 'string' },
      'write-baseline': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      repeat: { type: 'string', default: '1' },
    },
  })
  const mode = values.mode
  if (mode !== 'replay' && mode !== 'record' && mode !== 'live') {
    throw new Error(`Unknown --mode "${String(mode)}" (use replay, record or live)`)
  }
  const repeat = Number(values.repeat)
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    throw new Error(`--repeat must be a whole number from 1 to ${MAX_REPEAT}`)
  }
  // Replay gives the same answer every time, and a recording keeps one answer per request.
  if (repeat > 1 && mode !== 'live') throw new Error('--repeat above 1 needs --mode live')
  return { mode, group: values.group, scenario: values.scenario, writeBaseline: values['write-baseline'], help: values.help, repeat }
}

/** One result for a scenario run several times: it passes only when every run passes. An error wins over a fail. */
export function combineRuns(runs: Result[]): Result {
  if (runs.length === 1) return runs[0]!
  const passed = runs.filter((r) => r.verdict === 'pass').length
  const worst = runs.find((r) => r.verdict === 'error') ?? runs.find((r) => r.verdict === 'fail')
  const used = runs.flatMap((r) => (r.usage ? [r.usage] : []))
  const sum = (f: (u: (typeof used)[number]) => number) => used.reduce((n, u) => n + f(u), 0)
  const costUsd = used.length === runs.length && used.every((u) => u.costUsd !== undefined) ? sum((u) => u.costUsd!) : undefined
  return {
    id: runs[0]!.id,
    group: runs[0]!.group,
    verdict: worst?.verdict ?? 'pass',
    failures: worst?.failures ?? [],
    ...(used.length > 0
      ? { usage: { inputTokens: sum((u) => u.inputTokens), outputTokens: sum((u) => u.outputTokens), ...(costUsd === undefined ? {} : { costUsd }) } }
      : {}),
    ms: runs.reduce((n, r) => n + (r.ms ?? 0), 0),
    runs: { passed, total: runs.length },
  }
}

/** Returns the ids that were `pass` in the baseline and are not `pass` now. */
export function compareBaseline(baseline: Baseline, results: Result[]): string[] {
  return results.filter((r) => baseline[r.id] === 'pass' && r.verdict !== 'pass').map((r) => r.id)
}

/** Scenarios that ran to a verdict. An error says nothing about the agent, so its old recording and baseline stay. */
export function finishedIds(results: Result[]): string[] {
  return results.filter((r) => r.verdict !== 'error').map((r) => r.id)
}

/** Merged, so a filtered run does not drop the scenarios it skipped. */
export function mergeBaseline(baseline: Baseline, results: Result[]): Baseline {
  const next: Baseline = { ...baseline }
  for (const r of results) if (r.verdict !== 'error') next[r.id] = r.verdict
  return next
}

async function loadScenarios(args: CliArgs): Promise<Scenario[]> {
  const files = (await readdir(SCENARIO_DIR)).filter((f) => f.endsWith('.json'))
  const all: Scenario[] = []
  for (const f of files) {
    all.push(ScenarioSchema.parse(JSON.parse(await readFile(`${SCENARIO_DIR}/${f}`, 'utf8'))))
  }
  return all
    .filter((s) => (args.group === undefined || s.group === args.group) && (args.scenario === undefined || s.id === args.scenario))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

async function loadBaseline(): Promise<Baseline> {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}

function openAiFromEnv(): LLMPort | null {
  const env = process.env
  const missing = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL_DEFAULT'].filter((k) => !env[k])
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`)
    return null
  }
  return createOpenAICompatible({
    baseUrl: env.LLM_BASE_URL!,
    apiKey: env.LLM_API_KEY!,
    models: { default: env.LLM_MODEL_DEFAULT!, smart: env.LLM_MODEL_SMART || env.LLM_MODEL_DEFAULT! },
  })
}

async function gradeOne(
  llm: LLMPort,
  stack: Awaited<ReturnType<typeof startEvalStack>>,
  s: Scenario,
  misses: () => number,
): Promise<Result> {
  const before = misses()
  const started = Date.now()
  try {
    const outcome = await runScenario(stack, s)
    let inputTokens = 0
    let outputTokens = 0
    let costUsd: number | undefined = 0
    for (const e of outcome.events) {
      if (e.type !== 'llm.responded') continue
      inputTokens += e.payload.usage.inputTokens
      outputTokens += e.payload.usage.outputTokens
      costUsd = costUsd === undefined || e.payload.usage.costUsd === undefined ? undefined : costUsd + e.payload.usage.costUsd
    }
    if (misses() > before) throw new Error('cassette miss: the run sent a request that was never recorded; re-record')
    const failures = gradeDeterministic(s, outcome)
    if (s.expect.rubric !== undefined) {
      const j = await gradeRubric(llm, 'smart', s.expect.rubric, outcome, s.input.text)
      if (!j.pass) failures.push(`rubric: ${j.reason}`)
    }
    if (misses() > before) throw new Error('cassette miss in the rubric judge; re-record')
    return {
      id: s.id,
      group: s.group,
      verdict: failures.length === 0 ? 'pass' : 'fail',
      failures,
      usage: costUsd === undefined ? { inputTokens, outputTokens } : { inputTokens, outputTokens, costUsd },
      ms: Date.now() - started,
    }
  } catch (e) {
    if (e instanceof StackUnsafeError) throw e
    const failures = [e instanceof Error ? e.message : String(e)]
    return { id: s.id, group: s.group, verdict: 'error', failures, ms: Date.now() - started }
  }
}

async function main(): Promise<number> {
  let args: CliArgs
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const scenarios = await loadScenarios(args)
  if (scenarios.length === 0) {
    console.error('No scenario matches the filters')
    return 2
  }

  // Each scenario gets its own LLM port: replay reads only that scenario's entries, record tags them.
  const stored = await loadCassette(CASSETTE_PATH)
  const fresh = emptyCassette()
  let real: LLMPort | undefined
  let llmErrors = 0
  if (args.mode !== 'replay') {
    const provider = openAiFromEnv()
    if (!provider) return 2
    // A failed call is never recorded, so a cassette made with one cannot replay the run.
    real = {
      complete: (req) =>
        provider.complete(req).catch((e: unknown) => {
          llmErrors++
          throw e
        }),
    }
  }
  let current: LLMPort & { readonly misses?: number } = {
    complete: () => Promise.reject(new Error('no scenario is running')),
  }
  const llm: LLMPort = { complete: (req) => current.complete(req) }
  const misses = () => current.misses ?? 0

  const results: Result[] = []
  const stack = await startEvalStack({ llm })
  try {
    for (const [i, s] of scenarios.entries()) {
      if (args.mode === 'replay') current = replayingLlm(taggedCassette(stored, s.id))
      else current = args.mode === 'record' ? recordingLlm(real!, fresh, s.id) : real!
      try {
        const runs: Result[] = []
        for (let k = 0; k < args.repeat; k++) runs.push(await gradeOne(llm, stack, s, misses))
        results.push(combineRuns(runs))
      } catch (e) {
        if (!(e instanceof StackUnsafeError)) throw e
        // A run that is still going could change the shop under the next scenarios, so none of them is graded.
        results.push({ id: s.id, group: s.group, verdict: 'error', failures: [e.message], ms: 0 })
        for (const rest of scenarios.slice(i + 1)) {
          results.push({ id: rest.id, group: rest.group, verdict: 'error', failures: [`not run: ${s.id} left a run going`], ms: 0 })
        }
        break
      }
    }
  } finally {
    // Save before closing, so a failure while closing cannot lose a paid recording.
    // Scenarios that did not run, or ended in an error, keep their entries.
    if (args.mode === 'record' && llmErrors === 0) {
      await saveCassette(CASSETTE_PATH, replaceTagged(stored, fresh, finishedIds(results)))
    }
    await stack.close()
  }

  console.log(formatReport(results))
  if (args.mode === 'record' && llmErrors > 0) {
    console.error(`${llmErrors} LLM call(s) failed while recording; the cassette and the baseline were not saved`)
    return 1
  }
  const baseline = await loadBaseline()
  const regressions = compareBaseline(baseline, results)
  for (const id of regressions) console.error(`REGRESSION: ${id} passed in the baseline and does not pass now`)
  const untracked = args.writeBaseline ? [] : results.filter((r) => !(r.id in baseline) && r.verdict !== 'pass')
  for (const r of untracked) console.error(`UNTRACKED: ${r.id} does not pass and is not in baseline.json`)
  if (args.writeBaseline) {
    await writeFile(BASELINE_PATH, `${JSON.stringify(mergeBaseline(baseline, results), null, 2)}\n`)
  }
  return results.some((r) => r.verdict === 'error') || regressions.length > 0 || untracked.length > 0 ? 1 : 0
}

// Compared as real paths: a different drive-letter case or a symlink must not skip the run silently.
if (process.argv[1] && realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    },
  )
}

