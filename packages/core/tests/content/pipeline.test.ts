import { createSecretMatcher } from '../../src/content/secrets'
import { screenContent, screenedToolResponse } from '../../src/content/pipeline'

const secrets = createSecretMatcher(['known-secret-value'])

test('screenContent removes secrets and counts them', async () => {
  const out = await screenContent('AKIAIOSFODNN7EXAMPLE and known-secret-value', { secrets })
  expect(out).toEqual({ content: '[REDACTED:aws_access_key] and [REDACTED:known_secret]', redactions: { aws_access_key: 1, known_secret: 1 } })
})

test('screenedToolResponse builds a tool.responded with the labels and redactions', async () => {
  const event = await screenedToolResponse({ toolCallId: 'c1' }, { content: 'k AKIAIOSFODNN7EXAMPLE', isError: true }, ['internal'], { secrets })
  expect(event).toEqual({
    type: 'tool.responded',
    payload: { toolCallId: 'c1', content: 'k [REDACTED:aws_access_key]', isError: true, redactions: { aws_access_key: 1 } },
    labels: ['internal'],
  })
})

test('screenedToolResponse leaves out redactions when nothing was removed', async () => {
  const event = await screenedToolResponse({ toolCallId: 'c1' }, { content: 'plain', isError: false }, ['trusted'], { secrets })
  expect(event).toEqual({ type: 'tool.responded', payload: { toolCallId: 'c1', content: 'plain', isError: false }, labels: ['trusted'] })
})
