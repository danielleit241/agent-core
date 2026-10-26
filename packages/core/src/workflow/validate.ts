import { z } from 'zod'
import { BUILTIN_PREFIX } from '../runner/builtins'
import type { AgentDefinition, Step, Workflow } from '../types'

/** The step ids a step can go to next. */
export function nextTargets(step: Step): string[] {
  if (step.next === undefined) return []
  if (typeof step.next === 'string') return [step.next]
  return [...step.next.when.map((r) => r.goto), ...(step.next.else === undefined ? [] : [step.next.else])]
}

/** Every `$ref` string in a value, at any depth. */
export function refsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsIn)
  if (value === null || typeof value !== 'object') return []
  const ref = (value as { $ref?: unknown }).$ref
  if (typeof ref === 'string') return [ref]
  return Object.values(value).flatMap(refsIn)
}

function cycles(wf: Workflow): string[][] {
  const found: string[][] = []
  const done = new Set<string>()
  const visit = (id: string, path: string[]) => {
    const at = path.indexOf(id)
    if (at >= 0) return void found.push([...path.slice(at), id])
    if (done.has(id) || !Object.hasOwn(wf.steps, id)) return
    for (const t of nextTargets(wf.steps[id]!)) visit(t, [...path, id])
    done.add(id)
  }
  for (const id of Object.keys(wf.steps)) visit(id, [])
  return found
}

/**
 * What is wrong with an agent's workflows, one line per problem with its path. Checked when the agent is
 * saved: a cycle of tool steps would run with no limit to stop it, so every workflow must be acyclic.
 */
export function workflowProblems(agent: AgentDefinition): string[] {
  const problems: string[] = []
  for (const [name, wf] of Object.entries(agent.workflows ?? {})) {
    const at = `workflows.${name}`
    const exists = (id: string) => Object.hasOwn(wf.steps, id)
    if (!exists(wf.start)) problems.push(`${at}.start: step "${wf.start}" does not exist`)
    for (const [id, step] of Object.entries(wf.steps)) {
      const here = `${at}.steps.${id}`
      for (const t of nextTargets(step)) if (!exists(t)) problems.push(`${here}.next: step "${t}" does not exist`)
      const refs = step.kind === 'tool' ? { field: 'args', value: step.args } : step.kind === 'subrun' ? { field: 'input', value: step.input } : null
      for (const ref of refs === null ? [] : refsIn(refs.value)) {
        if (ref !== '$input.text' && !exists(ref.split('.')[0]!)) problems.push(`${here}.${refs!.field}: $ref "${ref}" names no step`)
      }
      if (step.kind === 'tool' && step.tool.startsWith(BUILTIN_PREFIX)) problems.push(`${here}.tool: built-in tools cannot be workflow steps`)
      if (step.kind === 'llm' && step.output_schema !== undefined) {
        try {
          z.fromJSONSchema(step.output_schema as Parameters<typeof z.fromJSONSchema>[0])
        } catch {
          problems.push(`${here}.output_schema: not a supported JSON Schema`)
        }
      }
    }
    for (const cycle of cycles(wf)) problems.push(`${at}.steps.${cycle[0]}.next: the steps form a cycle (${cycle.join(' → ')})`)
  }
  return problems
}
