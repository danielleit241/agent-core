import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { requestHash } from '@agent-core/core'
import type { LLMPort } from '@agent-core/core'

export type LlmResponse = Awaited<ReturnType<LLMPort['complete']>>
/** `tag` groups entries (for example by eval scenario), so one group can be replayed or re-recorded on its own. */
export type CassetteEntry = { hash: string; model: string; tag?: string; response: LlmResponse }
export type Cassette = { version: 1; entries: CassetteEntry[] }

export class CassetteMissError extends Error {
  readonly retryable = false
  readonly hash: string
  constructor(hash: string) {
    super(`No cassette entry left for request ${hash}`)
    this.name = 'CassetteMissError'
    this.hash = hash
  }
}

export function emptyCassette(): Cassette {
  return { version: 1, entries: [] }
}

export function recordingLlm(inner: LLMPort, cassette: Cassette, tag?: string): LLMPort {
  return {
    async complete(req) {
      const response = await inner.complete(req)
      cassette.entries.push({
        hash: requestHash(req),
        model: req.model,
        ...(tag === undefined ? {} : { tag }),
        response: structuredClone(response),
      })
      return response
    },
  }
}

/** `misses` counts requests that had no entry, so a caller can tell a miss from any other failure. */
export function replayingLlm(cassette: Cassette): LLMPort & { readonly misses: number } {
  const seen = new Map<string, number>()
  let misses = 0
  return {
    get misses() {
      return misses
    },
    async complete(req) {
      const hash = requestHash(req)
      const k = seen.get(hash) ?? 0
      const entry = cassette.entries.filter((e) => e.hash === hash)[k]
      if (!entry) {
        misses++
        throw new CassetteMissError(hash)
      }
      seen.set(hash, k + 1)
      const response = structuredClone(entry.response)
      if (response.message.toolCalls) {
        response.message.toolCalls = response.message.toolCalls.map((c) => ({ ...c, id: `call_${randomUUID()}` }))
      }
      return response
    },
  }
}

/** The entries with this tag, as a cassette of their own. */
export function taggedCassette(c: Cassette, tag: string): Cassette {
  return { version: 1, entries: c.entries.filter((e) => e.tag === tag) }
}

/** `base` with every entry whose tag is in `tags` replaced by the entries of `fresh`. */
export function replaceTagged(base: Cassette, fresh: Cassette, tags: string[]): Cassette {
  const replaced = new Set(tags)
  return { version: 1, entries: [...base.entries.filter((e) => e.tag === undefined || !replaced.has(e.tag)), ...fresh.entries] }
}

export async function loadCassette(path: string): Promise<Cassette> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyCassette()
    throw e
  }
  const parsed = JSON.parse(raw) as Partial<Cassette>
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Unsupported cassette version in ${path}: ${String(parsed.version)}`)
  }
  return parsed as Cassette
}

export async function saveCassette(path: string, c: Cassette): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(c, null, 2)}\n`)
}
