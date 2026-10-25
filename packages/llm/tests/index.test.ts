import * as llm from '@agent-core/llm'
import * as cassette from '@agent-core/llm/cassette'

test('the root export holds providers only; the eval cassette has its own entry', () => {
  expect(llm).toHaveProperty('createOpenAICompatible')
  expect(llm).not.toHaveProperty('recordingLlm')
  expect(llm).not.toHaveProperty('saveCassette')
  expect(cassette).toHaveProperty('recordingLlm')
  expect(cassette).toHaveProperty('replayingLlm')
})
