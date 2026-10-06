import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const MUTATION_JUDGED_EVENT = 'mutation-judged'

const CARD = /^#?(\d+)$/

export function cardId(card: string): string | null {
  return CARD.exec(card)?.[1] ?? null
}

export interface JudgedEntry {
  card: string
  id: string
  outcome: string
  matched: boolean
}

export function mutationJudgedLine(entry: JudgedEntry, at: Date): string {
  return JSON.stringify({ event: MUTATION_JUDGED_EVENT, card: entry.card, id: entry.id, outcome: entry.outcome, matched: entry.matched, ts: at.toISOString() })
}

export function journalJudged(journal: string, entry: JudgedEntry, at: Date): void {
  mkdirSync(path.dirname(journal), { recursive: true })
  appendFileSync(journal, `${mutationJudgedLine(entry, at)}\n`)
}
