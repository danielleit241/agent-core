import { pathToFileURL } from 'node:url'
import { probeModel } from '@agent-core/llm'
import { createPool } from '@agent-core/store-postgres'
import { doctor } from './doctor'
import type { DoctorDeps } from './doctor'
import { logVerify } from './log-verify'
import { readServiceConfig } from '../config'

export type CliEnv = Record<string, string | undefined>
export type CliIo = { out: (line: string) => void; err: (line: string) => void; fetch: typeof fetch }

const USAGE = `Usage: agent-core <command>

Commands:
  log verify <run-id>   Recompute the hash chain of a run's event log.
                        Reads AGENT_CORE_URL (default http://localhost:7300) and AGENT_CORE_API_KEY.
                        Exit 0: intact. 1: broken. 2: the log could not be read.
  doctor                Check the environment, the database, the LLM settings and one real model call.
                        Reads the same environment as the service and changes nothing.
                        Exit 0: no check failed. 1: at least one check failed.
`

/** The real model probe and database pools, built from the environment the service would read. */
function realDoctorDeps(env: CliEnv): DoctorDeps {
  return {
    connect: createPool,
    probe: (model) => {
      const config = readServiceConfig(env)
      if (!config.ok || config.llm === null) throw new Error('the LLM is not configured')
      return probeModel({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model })
    },
  }
}

/** Runs one command and returns the exit code. */
export async function main(argv: string[], env: CliEnv, io: CliIo, doctorDeps: DoctorDeps = realDoctorDeps(env)): Promise<number> {
  const [group, sub, ...rest] = argv
  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  if (group === 'log' && sub === 'verify') {
    if (wantsHelp) {
      io.out(USAGE.trimEnd())
      return 0
    }
    if (rest.length !== 1) {
      io.err('error: log verify takes one run id.')
      return 2
    }
    return logVerify(rest[0]!, env, io)
  }
  if (group === 'doctor' && sub === undefined) return doctor(env, io, doctorDeps)
  if (wantsHelp || argv.length === 0) {
    io.out(USAGE.trimEnd())
    return argv.length === 0 ? 2 : 0
  }
  io.err(`error: unknown command "${argv.join(' ')}". Run with --help.`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l), fetch }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('agent-core: command failed', err instanceof Error ? err.message : 'error')
      process.exit(2)
    },
  )
}
