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
  const marks: number[] = []

  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    }
    catch {
      continue
    }

    if (parsed === null || typeof parsed !== 'object')
      continue
    const entry = parsed as Record<string, unknown>
    const mark = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    if (!Number.isNaN(mark))
      marks.push(mark)
    if (entry.type === 'result')
      found = entry
  }

  const duration_ms = marks.length < 2 ? null : Math.max(...marks) - Math.min(...marks)

  if (found === undefined)
    return { ...MISSING, duration_ms }

  return {
    resultLine: 'present',
    total_cost_usd: (found.total_cost_usd as number | undefined) ?? null,
    num_turns: (found.num_turns as number | undefined) ?? null,
    duration_ms,
    usage: found.usage ?? null,
  }
}
