import { AgentDefinitionSchema } from '../../src/types'
import { workflowProblems } from '../../src/workflow/validate'

const agent = (workflows: unknown) =>
  AgentDefinitionSchema.parse({ id: 'ops', instructions: 'x', connections: [], autonomy: 'supervised', allow: [], workflows })

test('a valid workflow has no problems', () => {
  const def = agent({
    refund: {
      start: 'lookup',
      steps: {
        lookup: { kind: 'tool', tool: 'orders.get', args: { order_id: { $ref: '$input.text' } }, next: 'check' },
        check: { kind: 'approval', reason: 'refund', next: { when: [{ field: 'approved', is: { eq: true }, goto: 'refund' }] } },
        refund: { kind: 'tool', tool: 'payments.refund', args: { order_id: { $ref: 'lookup.id' }, amount: 5 } },
      },
    },
  })
  expect(workflowProblems(def)).toEqual([])
})

test('a cycle, a missing step, a bad $ref, a built-in tool and a bad output_schema are each reported with their path', () => {
  const def = agent({
    w: {
      start: 'nowhere',
      steps: {
        a: { kind: 'tool', tool: 'x.y', args: { v: { $ref: 'ghost.id' } }, next: 'b' },
        b: { kind: 'llm', prompt: 'p', output_schema: { type: 'nonsense' }, next: { when: [{ field: 'k', is: { eq: 1 }, goto: 'a' }], else: 'gone' } },
        c: { kind: 'tool', tool: 'agent_core.schedule_followup', args: {} },
      },
    },
  })
  expect(workflowProblems(def).sort()).toEqual(
    [
      'workflows.w.start: step "nowhere" does not exist',
      'workflows.w.steps.a.args: $ref "ghost.id" names no step',
      'workflows.w.steps.b.next: step "gone" does not exist',
      'workflows.w.steps.b.output_schema: not a supported JSON Schema',
      'workflows.w.steps.c.tool: built-in tools cannot be workflow steps',
      'workflows.w.steps.a.next: the steps form a cycle (a → b → a)',
    ].sort(),
  )
})

test('an agent without workflows has no problems', () => {
  expect(workflowProblems(agent(undefined))).toEqual([])
})
