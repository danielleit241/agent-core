import { formatCount } from './offload'

export type ReadOutputArgs = { handle: string; search?: string; offset?: number; length?: number }

const DEFAULT_LENGTH = 4_000
const MAX_LENGTH = 6_000
const MAX_MATCHES = 20
const LINE_CUT = 300
// Room for 20 lines of 300 characters and the closing sentence, with the 6,500 cap on the whole answer.
const MAX_OUTPUT = 6_500
const SEARCH_BUDGET = 6_200

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Lower case that keeps every offset. U+0130 is the only character whose lower case is longer in UTF-16,
 * so it is mapped to a plain `i` first.
 */
const lowered = (text: string): string => text.replace(/İ/g, 'i').toLowerCase()

/** The line around a match, cut to 300 characters with the match inside. */
function lineAround(text: string, pos: number, matchLength: number): { line: string; start: number } {
  const start = text.lastIndexOf('\n', pos - 1) + 1
  const nl = text.indexOf('\n', pos)
  const end = nl === -1 ? text.length : nl
  if (end - start <= LINE_CUT) return { line: text.slice(start, end), start }
  const from = Math.min(Math.max(start, pos - Math.floor((LINE_CUT - matchLength) / 2)), Math.max(start, end - LINE_CUT))
  let a = from
  let b = Math.min(end, from + LINE_CUT)
  if (isLowSurrogate(text.charCodeAt(a))) a += 1
  if (isHighSurrogate(text.charCodeAt(b - 1))) b -= 1
  return { line: text.slice(a, b), start }
}

function search(text: string, needle: string): string {
  if (needle === '') return 'The search text is empty. Send at least one character, or read a range with offset.'
  const hay = lowered(text)
  const target = lowered(needle)
  // Only the first matches are kept; the rest are counted.
  const found: number[] = []
  let total = 0
  for (let i = hay.indexOf(target); i !== -1; i = hay.indexOf(target, i + target.length)) {
    if (found.length < MAX_MATCHES) found.push(i)
    total++
  }
  if (total === 0) return `No match for "${needle}" in ${formatCount(text.length)} characters. The search is plain text and ignores case: no OR, quotes or wildcards. Search one word or phrase at a time.`
  const lines: string[] = []
  let used = 0
  let lineNo = 1
  let counted = 0
  for (const pos of found) {
    for (let i = text.indexOf('\n', counted); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) {
      lineNo++
      counted = i + 1
    }
    const row = `L${lineNo} @${pos}: ${lineAround(text, pos, target.length).line}`
    if (used + row.length + 1 > SEARCH_BUDGET && lines.length > 0) break
    lines.push(row)
    used += row.length + 1
  }
  if (lines.length < total) {
    lines.push(`Showing ${lines.length} of ${total} matches. Narrow the search, or read a range with offset.`)
  }
  return lines.join('\n').slice(0, MAX_OUTPUT)
}

function range(text: string, offset: number, wanted: number): string {
  if (offset >= text.length) return `Offset ${formatCount(offset)} is beyond the end: the output has ${formatCount(text.length)} characters.`
  let start = offset
  let end = Math.min(text.length, offset + Math.min(wanted, MAX_LENGTH))
  if (isLowSurrogate(text.charCodeAt(start)) && start > 0) start += 1
  if (isHighSurrogate(text.charCodeAt(end - 1)) && end < text.length) end -= 1
  return `Characters ${formatCount(start)}–${formatCount(end)} of ${formatCount(text.length)}.\n${text.slice(start, end)}`
}

/** What `agent_core.read_output` returns for the full text of a handle: a search or a range. At most 6,500 characters. */
export function readOutput(text: string, args: ReadOutputArgs): string {
  if (args.search !== undefined) return search(text, args.search)
  return range(text, args.offset ?? 0, args.length ?? DEFAULT_LENGTH)
}
