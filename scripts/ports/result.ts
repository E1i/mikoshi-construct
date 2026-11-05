import { rawUsageIn } from './client/claude/adapter.js'
import { streamReading } from './session.js'

export interface ResultFields {
  resultLine: 'present' | 'missing'
  total_cost_usd: number | null
  num_turns: number | null
  duration_ms: number | null
  usage: unknown | null
}

export function readResultFields(reportPath: string): ResultFields {
  const reading = streamReading(reportPath)
  return {
    resultLine: reading.end === 'missing' ? 'missing' : 'present',
    total_cost_usd: reading.costUsd,
    num_turns: reading.turns,
    duration_ms: reading.durationMs,
    usage: rawUsageIn(reportPath),
  }
}
