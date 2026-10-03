import type { Usage } from './usage.js'

export const STEPS = ['preflight', 'design', 'implement', 'verify'] as const
export type Step = typeof STEPS[number]

export interface RunStep {
  step: string
  role: string
  attempt: number
  effort: string | null
  tokens: number
  seconds: number
}

export interface StepAgent {
  label: string
  type: string
  phase: string | null
  usage: Usage
  first: string | null
  last: string | null
}

const EFFORT_IN_LABEL = /@ (\S+)$/

export function stepTokens(usage: Usage): number {
  return usage.input + usage.cacheWrite + usage.output
}

function secondsBetween(first: string | null, last: string | null): number {
  if (first == null || last == null)
    return 0
  return Math.round((Date.parse(last) - Date.parse(first)) / 1000)
}

function byFirstRecord(a: StepAgent, b: StepAgent): number {
  return Date.parse(a.first ?? '') - Date.parse(b.first ?? '') || a.label.localeCompare(b.label)
}

export function stepsOf(agents: StepAgent[]): RunStep[] {
  const seen = new Map<string, number>()
  return [...agents].sort(byFirstRecord).map((agent) => {
    const step = (agent.phase ?? agent.type).toLowerCase()
    const attempt = (seen.get(step) ?? 0) + 1
    seen.set(step, attempt)
    return {
      step,
      role: agent.type,
      attempt,
      effort: EFFORT_IN_LABEL.exec(agent.label)?.[1] ?? null,
      tokens: stepTokens(agent.usage),
      seconds: secondsBetween(agent.first, agent.last),
    }
  })
}
