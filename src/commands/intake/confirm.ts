import type { SlicedCard } from './slice.js'
import { createHash } from 'node:crypto'
import { correctionText } from './check.js'

export type Confirmation = 'auto' | 'person' | 'none'

const TOKEN_LENGTH = 12
export const INTAKE_EVENT = 'intake'

export function confirmationToken(cards: readonly SlicedCard[]): string {
  return createHash('sha256').update(cards.map(card => card.text).join('\n')).digest('hex').slice(0, TOKEN_LENGTH)
}

export function awaitsConfirmation(cards: readonly SlicedCard[]): boolean {
  return cards.some(card => card.corrections.length > 0)
}

export function confirmationOf(card: SlicedCard, autoConfirm: boolean): Confirmation {
  if (autoConfirm)
    return 'auto'
  return card.corrections.length > 0 ? 'person' : 'none'
}

export function intakeJournalLine(card: SlicedCard, confirmation: Confirmation, at: Date): string {
  return JSON.stringify({
    event: INTAKE_EVENT,
    task: String(card.id),
    card: card.line,
    confirmation,
    corrections: card.corrections.map(correctionText),
    ts: at.toISOString(),
  })
}
