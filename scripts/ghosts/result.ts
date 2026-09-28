import { existsSync, readFileSync } from 'node:fs'

export interface ResultFields {
  resultLine: 'present' | 'missing'
  total_cost_usd: number | null
  num_turns: number | null
  duration_ms: number | null
  usage: unknown | null
}

const MISSING: ResultFields = {
  resultLine: 'missing',
  total_cost_usd: null,
  num_turns: null,
  duration_ms: null,
  usage: null,
}

export function readResultFields(reportPath: string): ResultFields {
  if (!existsSync(reportPath))
    return MISSING

  const lines = readFileSync(reportPath, 'utf8').split('\n').filter(line => line !== '')
  let found: Record<string, unknown> | undefined

  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    }
    catch {
      continue
    }

    if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).type === 'result')
      found = parsed as Record<string, unknown>
  }

  if (found === undefined)
    return MISSING

  return {
    resultLine: 'present',
    total_cost_usd: (found.total_cost_usd as number | undefined) ?? null,
    num_turns: (found.num_turns as number | undefined) ?? null,
    duration_ms: (found.duration_ms as number | undefined) ?? null,
    usage: found.usage ?? null,
  }
}
