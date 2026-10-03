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

export interface UnreadAgent {
  run: string
  agent: string
  reason: string
}

export interface RunDecomposition {
  steps: RunStep[]
  unread: UnreadAgent[]
}

const EFFORT_IN_LABEL = /@ (\S+)$/

function stepTokens(usage: Usage): number {
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

function isStep(name: string): name is Step {
  return (STEPS as readonly string[]).includes(name)
}

function unreadReason(phase: string | null): string {
  return phase == null ? 'no workflow phase' : `phase ${phase.toLowerCase()} is not a step`
}

export function stepsOf(run: string, agents: StepAgent[]): RunDecomposition {
  const seen = new Map<Step, number>()
  const decomposition: RunDecomposition = { steps: [], unread: [] }
  for (const agent of [...agents].sort(byFirstRecord)) {
    const step = agent.phase?.toLowerCase() ?? ''
    if (!isStep(step)) {
      decomposition.unread.push({ run, agent: agent.label, reason: unreadReason(agent.phase) })
      continue
    }
    const attempt = (seen.get(step) ?? 0) + 1
    seen.set(step, attempt)
    decomposition.steps.push({
      step,
      role: agent.type,
      attempt,
      effort: EFFORT_IN_LABEL.exec(agent.label)?.[1] ?? null,
      tokens: stepTokens(agent.usage),
      seconds: secondsBetween(agent.first, agent.last),
    })
  }
  return decomposition
}
