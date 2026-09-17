export interface Usage {
  calls: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  models: string[]
}

export interface AgentUsage {
  label: string
  type: string
  usage: Usage
}

export interface WorkflowRun {
  session: string
  run: string
  startedAt: string
  agents: AgentUsage[]
  total: Usage
}

export const PRICE_RELATIVE_TO_INPUT = { cacheWrite: 1.25, cacheRead: 0.1, output: 5 }

export function emptyUsage(): Usage {
  return { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, models: [] }
}

export function billable(usage: Usage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead + usage.output
}

export function weighted(usage: Usage): number {
  return Math.round(usage.input + usage.cacheWrite * PRICE_RELATIVE_TO_INPUT.cacheWrite + usage.cacheRead * PRICE_RELATIVE_TO_INPUT.cacheRead + usage.output * PRICE_RELATIVE_TO_INPUT.output)
}

export function add(total: Usage, part: Usage): void {
  total.calls += part.calls
  total.input += part.input
  total.cacheWrite += part.cacheWrite
  total.cacheRead += part.cacheRead
  total.output += part.output
  for (const model of part.models) {
    if (!total.models.includes(model))
      total.models.push(model)
  }
}
