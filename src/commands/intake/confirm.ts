import type { Correction } from './check.js'
import type { SlicedCard } from './slice.js'
import { createHash } from 'node:crypto'
import { SEAM_PREFIX } from '../../card/risk.js'
import { COMPANION_REASON, correctionText } from './check.js'

export type Confirmation = 'auto' | 'person' | 'none'

const TOKEN_LENGTH = 12
export const INTAKE_EVENT = 'intake'
export const TOUCHES_HEADER = 'touches: '

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, TOKEN_LENGTH)
}

function headerAndBody(text: string): { header: string[], body: string } {
  const lines = text.split('\n')
  const headerEnd = lines.findIndex(line => line.trim() === '')
  if (headerEnd === -1)
    return { header: lines, body: '' }
  return { header: lines.slice(0, headerEnd), body: lines.slice(headerEnd).join('\n').trim() }
}

export function bodyShaWithoutTouches(text: string): string {
  return digest(headerAndBody(text).body)
}

export function bodySha(text: string): string {
  const { header, body } = headerAndBody(text)
  const touches = header.find(line => line.startsWith(TOUCHES_HEADER)) ?? ''
  return digest(`${touches}\n${body}`)
}

export function confirmationToken(cards: readonly SlicedCard[]): string {
  return createHash('sha256').update(cards.map(card => card.text).join('\n')).digest('hex').slice(0, TOKEN_LENGTH)
}

function proposesRiskSlices(card: SlicedCard): boolean {
  return card.risk.some(line => line.startsWith(SEAM_PREFIX))
}

function dropsMergedDepends(correction: Correction): boolean {
  return correction.field === 'depends' && correction.now === '(removed)' && correction.reason === 'already merged'
}

function addsCompanion(correction: Correction): boolean {
  return correction.field === 'touches' && correction.reason === COMPANION_REASON
}

export function correctionsNeedPerson(card: Pick<SlicedCard, 'corrections'>): boolean {
  return !card.corrections.every(correction => dropsMergedDepends(correction) || addsCompanion(correction))
}

function needsPerson(card: SlicedCard): boolean {
  return correctionsNeedPerson(card) || proposesRiskSlices(card)
}

export function awaitsConfirmation(cards: readonly SlicedCard[]): boolean {
  return cards.some(needsPerson)
}

export function confirmationOf(card: SlicedCard, autoConfirm: boolean): Confirmation {
  if (autoConfirm)
    return 'auto'
  return needsPerson(card) ? 'person' : 'none'
}

export function intakeJournalLine(card: SlicedCard, confirmation: Confirmation, at: Date, source?: string): string {
  return JSON.stringify({
    event: INTAKE_EVENT,
    task: String(card.id),
    card: card.line,
    confirmation,
    corrections: card.corrections.map(correctionText),
    bodySha: bodySha(card.text),
    ...(source === undefined ? {} : { source }),
    ts: at.toISOString(),
  })
}
