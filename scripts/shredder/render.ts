import type { Row } from './row.js'
import { VOCABULARY } from './vocabulary.js'

export interface ShredderOutput {
  vocabulary: readonly string[]
  rows: Row[]
  notChecked: string[]
}

export function toJson(rows: Row[], notChecked: string[]): ShredderOutput {
  return { vocabulary: VOCABULARY, rows, notChecked }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

export function toTable(rows: Row[], notChecked: string[]): string {
  const lines = [
    '| Task | Verification | Class | Why | Contour | unresolved |',
    '|---|---|---|---|---|---|',
  ]
  for (const row of rows) {
    const contourSummary = [
      row.contour.after.length > 0 ? `after: ${row.contour.after.join(', ')}` : '',
      row.contour.parallelWith.length > 0 ? `parallel: ${row.contour.parallelWith.join(', ')}` : '',
      row.contour.locks.length > 0 ? `locks: ${row.contour.locks.join(', ')}` : '',
      row.contour.worktree ?? '',
    ].filter(part => part !== '').join('; ')
    const unresolvedSummary = row.unresolved.map(item => `${item.level}: ${item.reason}`).join('; ')
    lines.push(`| ${escapeCell(row.task)} | ${escapeCell(row.verification.join(', '))} | ${escapeCell(row.class ?? 'null')} | ${escapeCell(row.why.join('; '))} | ${escapeCell(contourSummary)} | ${escapeCell(unresolvedSummary)} |`)
  }
  for (const kind of notChecked)
    lines.push(`not checked: ${kind}`)
  return lines.join('\n')
}
