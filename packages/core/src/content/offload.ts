/** What a long content leaves in the log and in the LLM context: a handle to the full text, which is in `ContentStore`. */
export type Offload = { handle: string; hash: string; chars: number; lines: number }

export const PREVIEW_HEAD = 1_200
export const PREVIEW_TAIL = 400
/** Content above this is stored cut (head and tail), so one output cannot fill the database. */
export const MAX_STORED_CHARS = 8_000_000

const MAX_SHAPE_KEYS = 8
const MAX_SHAPE_CHARS = 200

export const handleOf = (hash: string): string => `out_${hash.slice(0, 12)}`

export const formatCount = (n: number): string => n.toLocaleString('en-US')

/** What a cleared tool output reads as in the context (compaction). */
export const compactionStub = (handle: string, chars: number): string =>
  `[Output cleared to keep the context small: ${handle}, ${formatCount(chars)} characters. Read it again with agent_core.read_output.]`

// Every handle has the same length, so a stub's size is known before its handle is.
export const stubSize = (chars: number): number => compactionStub(handleOf('0'.repeat(12)), chars).length

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** Keeps the head and the tail of a text that is over the cap, with a notice; the cuts never split a surrogate pair. */
export function capStored(text: string): string {
  if (text.length <= MAX_STORED_CHARS) return text
  // Room for the notice, so the stored text is within the cap.
  const half = (MAX_STORED_CHARS - 100) / 2
  const headEnd = isHighSurrogate(text.charCodeAt(half - 1)) ? half - 1 : half
  const tailStart = isLowSurrogate(text.charCodeAt(text.length - half)) ? text.length - half + 1 : text.length - half
  return `${text.slice(0, headEnd)}\n[… ${formatCount(tailStart - headEnd)} characters cut to keep the stored output small …]\n${text.slice(tailStart)}`
}

/** Cuts to `max` characters without leaving half of a surrogate pair. */
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text
  return text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max)
}

// Keys come from the output: quoted, they cannot close the preview header or start a line of their own.
const quote = (key: string): string => JSON.stringify(key)

const plural = (n: number, word: string): string => `${formatCount(n)} ${word}`
const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `array of ${v.every(isObject) && v.length > 0 ? plural(v.length, 'objects') : plural(v.length, 'items')}`
  return typeof v === 'object' ? 'object' : typeof v
}

/** A one-line outline of the top level when the text is JSON; empty otherwise. */
export function shapeOf(text: string): string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return ''
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isObject)) {
      const keys = Object.keys(value[0] as object)
      const shown = keys.slice(0, MAX_SHAPE_KEYS).map(quote).join(', ')
      return cut(`JSON array of ${plural(value.length, 'objects')} with keys ${shown}${keys.length > MAX_SHAPE_KEYS ? ', …' : ''}.`, MAX_SHAPE_CHARS)
    }
    return `JSON array of ${plural(value.length, 'items')}.`
  }
  if (!isObject(value)) return ''
  const entries = Object.entries(value as Record<string, unknown>)
  const shown = entries.slice(0, MAX_SHAPE_KEYS).map(([k, v]) => `${quote(k)} (${describe(v)})`)
  return cut(`JSON object: ${shown.join(', ')}${entries.length > MAX_SHAPE_KEYS ? ', …' : ''}.`, MAX_SHAPE_CHARS)
}

/**
 * The text that stands in the log and in the context for an offloaded content: a header with the handle, the first
 * and the last part of the text. A text that is no longer than head and tail together is shown whole.
 */
export function offloadPreview(text: string, offload: Offload): string {
  const shape = shapeOf(text)
  const header =
    `[Output ${offload.handle}: ${formatCount(offload.chars)} characters, ${formatCount(offload.lines)} lines.${shape === '' ? '' : ` ${shape}`}\n` +
    `Shown: the first ${formatCount(PREVIEW_HEAD)} and the last ${PREVIEW_TAIL} characters. Read more with agent_core.read_output: ` +
    `{"handle":"${offload.handle}","search":"…"} or {"handle":"${offload.handle}","offset":0,"length":4000}.]`
  if (text.length <= PREVIEW_HEAD + PREVIEW_TAIL) return `${header}\n${text}`
  let head = PREVIEW_HEAD
  let tail = text.length - PREVIEW_TAIL
  if (isHighSurrogate(text.charCodeAt(head - 1))) head -= 1
  if (isLowSurrogate(text.charCodeAt(tail))) tail += 1
  return `${header}\n${text.slice(0, head)}\n[… ${formatCount(tail - head)} characters not shown …]\n${text.slice(tail)}`
}

export const countLines = (text: string): number => {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}
