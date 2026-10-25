import { expect, test } from 'vitest'
import { signWebhook, verifyWebhook } from '../src/webhook-signature'

test('a valid signature verifies', () => {
  const h = signWebhook('{"a":1}', 's3cret', 1761290000)
  expect(h).toMatch(/^t=1761290000,v1=[0-9a-f]{64}$/)
  expect(verifyWebhook('{"a":1}', h, 's3cret', 1761290100)).toBe(true)
})
test('a tampered body fails', () => {
  const h = signWebhook('{"a":1}', 's3cret', 1761290000)
  expect(verifyWebhook('{"a":2}', h, 's3cret', 1761290000)).toBe(false)
})
test('an old timestamp fails', () => {
  const h = signWebhook('{}', 's3cret', 1761290000)
  expect(verifyWebhook('{}', h, 's3cret', 1761290000 + 301)).toBe(false)
})
test('a future timestamp beyond tolerance fails', () => {
  const h = signWebhook('{}', 's3cret', 1761290000 + 301)
  expect(verifyWebhook('{}', h, 's3cret', 1761290000)).toBe(false)
})
test('a wrong secret fails', () => {
  const h = signWebhook('{}', 's3cret', 1761290000)
  expect(verifyWebhook('{}', h, 'other', 1761290000)).toBe(false)
})
test('a malformed header returns false and never throws', () => {
  for (const h of ['', 'garbage', 't=abc,v1=00', 't=1761290000', 'v1=ab', 't=1761290000,v1=zz', 't=1761290000,v1=abcd']) {
    expect(verifyWebhook('{}', h, 's3cret', 1761290000)).toBe(false)
  }
})
