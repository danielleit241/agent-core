import { readOutput } from '../../src/content/read-output'
import { wellFormed } from '../support/well-formed'

const H = 'out_x'

test('search is case-insensitive and gives line, offset and the line', () => {
  const text = 'first line\nSecond Line with NEEDLE here\nthird'
  expect(readOutput(text, { handle: H, search: 'needle' })).toBe(`L2 @${text.indexOf('NEEDLE')}: Second Line with NEEDLE here`)
})

test('search treats regex metacharacters as literal text', () => {
  const text = 'a.b\naxb\n(a+)'
  expect(readOutput(text, { handle: H, search: 'a.b' })).toBe('L1 @0: a.b')
  expect(readOutput(text, { handle: H, search: '(a+)' })).toBe('L3 @8: (a+)')
})

test('search shows 20 matches and says how many there are', () => {
  const text = Array.from({ length: 57 }, (_, i) => `hit ${i}`).join('\n')
  const out = readOutput(text, { handle: H, search: 'hit' })
  expect(out.split('\n')).toHaveLength(21)
  expect(out.split('\n')[0]).toBe('L1 @0: hit 0')
  expect(out.endsWith('Showing 20 of 57 matches. Narrow the search, or read a range with offset.')).toBe(true)
})

test('search says so when nothing matches', () => {
  expect(readOutput('abc', { handle: H, search: 'zzz' })).toBe('No match for "zzz" in 3 characters.')
})

test('a long line is cut to 300 characters around the match', () => {
  const text = 'x'.repeat(1_000) + 'NEEDLE' + 'y'.repeat(1_000)
  const line = readOutput(text, { handle: H, search: 'needle' })
  expect(line.startsWith('L1 @1000: ')).toBe(true)
  expect(line).toContain('NEEDLE')
  expect(line.length).toBeLessThanOrEqual(10 + 300 + 4)
})

test('search output stays within 6,500 characters', () => {
  const text = Array.from({ length: 100 }, () => 'hit ' + 'z'.repeat(400)).join('\n')
  expect(readOutput(text, { handle: H, search: 'hit' }).length).toBeLessThanOrEqual(6_500)
})

test('a range has a header and defaults to 4,000 characters', () => {
  const text = 'a'.repeat(1_048_576)
  const out = readOutput(text, { handle: H })
  expect(out.startsWith('Characters 0–4,000 of 1,048,576.\n')).toBe(true)
  expect(out).toHaveLength('Characters 0–4,000 of 1,048,576.\n'.length + 4_000)
})

test('a range length is capped at 6,000', () => {
  const out = readOutput('a'.repeat(100_000), { handle: H, offset: 10, length: 50_000 })
  expect(out.startsWith('Characters 10–6,010 of 100,000.\n')).toBe(true)
  expect(out.length).toBeLessThanOrEqual(6_500)
})

test('an offset beyond the end gives a message, not an exception', () => {
  expect(readOutput('abc', { handle: H, offset: 10 })).toBe('Offset 10 is beyond the end: the output has 3 characters.')
})

test('a range never splits a surrogate pair', () => {
  const text = '😀'.repeat(10)
  const out = readOutput(text, { handle: H, offset: 1, length: 3 })
  expect(wellFormed(out)).toBe(true)
})

test('searching a common letter in 1 MB is fast and reports the full count', () => {
  const text = 'e'.repeat(1_048_576)
  const start = performance.now()
  const out = readOutput(text, { handle: H, search: 'e' })
  expect(performance.now() - start).toBeLessThan(200)
  expect(out.endsWith('Showing 20 of 1048576 matches. Narrow the search, or read a range with offset.')).toBe(true)
})

test('an empty search is refused with a message', () => {
  expect(readOutput('abc', { handle: H, search: '' })).toBe('The search text is empty. Send at least one character, or read a range with offset.')
})

test('a text with a character whose lower case is longer keeps the offsets right', () => {
  const text = 'İİİ needle'
  expect(readOutput(text, { handle: H, search: 'NEEDLE' })).toBe(`L1 @4: ${text}`)
})
