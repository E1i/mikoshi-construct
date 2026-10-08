import type { LeftCard } from './parking.js'
import path from 'node:path'
import { DEPENDS_FAILED } from './parking.js'

export const OUTCOMES_FILE = 'shift-report.md'

export type Result = 'done' | 'failed' | 'skipped' | `stop ${string}`

export interface Outcome {
  card: string
  result: Result
  reason: string
  pr: number | undefined
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function skippedOutcomes(left: readonly LeftCard[], ran: ReadonlySet<string>): Outcome[] {
  return left.filter(card => card.reason.startsWith(DEPENDS_FAILED) && !ran.has(card.id)).map(card => ({ card: `#${card.id}`, result: 'skipped', reason: card.reason, pr: undefined }))
}

export function outcomesTable(outcomes: readonly Outcome[]): string {
  const rows = outcomes.map(outcome => `| ${cell(outcome.card)} | ${outcome.result} | ${cell(outcome.reason)} | ${outcome.pr === undefined ? '—' : `PR #${outcome.pr}`} |`)
  return ['| card | result | reason | PR |', '|------|--------|--------|----|', ...rows, ''].join('\n')
}

export function outcomesPath(dir: string): string {
  return path.join(dir, OUTCOMES_FILE)
}
