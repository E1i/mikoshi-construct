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

export interface MutationJudgedLine extends JudgedEntry {
  event: typeof MUTATION_JUDGED_EVENT
  ts: string
}

export type MutationJudgedPort = (line: MutationJudgedLine) => string

export function mutationJudgedLine(entry: JudgedEntry, at: Date): MutationJudgedLine {
  return { event: MUTATION_JUDGED_EVENT, card: entry.card, id: entry.id, outcome: entry.outcome, matched: entry.matched, ts: at.toISOString() }
}
