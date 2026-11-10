import type { Correction } from './check.js'
import type { SlicedCard } from './slice.js'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { SEAM_PREFIX } from '../../card/risk.js'
import { COMPANION_REASON, COVERING_REASON } from './check.js'

const WINDOW_UNDER_SHARD = 'window under shard '

export type Confirmation = 'auto' | 'person' | 'none' | `${typeof WINDOW_UNDER_SHARD}${string}`

const TOKEN_LENGTH = 12
const FIXED_CONFIRMATIONS: readonly unknown[] = ['auto', 'person', 'none']
export const TOUCHES_HEADER = 'touches: '
export const WINDOW_SHARD_VARIABLE = 'CONSTRUCT_WINDOW_SHARD'

export function windowShard(): string | null {
  return process.env[WINDOW_SHARD_VARIABLE]?.trim() || null
}

export function tokenConfirmation(): Confirmation {
  const shard = windowShard()
  return shard === null ? 'person' : `${WINDOW_UNDER_SHARD}${shard}`
}

export function isConfirmation(value: unknown): value is Confirmation {
  return FIXED_CONFIRMATIONS.includes(value) || (typeof value === 'string' && value.startsWith(WINDOW_UNDER_SHARD))
}

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

export function headerLinesOf(text: string): string[] {
  return headerAndBody(text).header
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
  return correction.field === 'touches' && (correction.reason === COMPANION_REASON || correction.reason === COVERING_REASON)
}

export function correctionsNeedPerson(card: Pick<SlicedCard, 'corrections'>): boolean {
  return !card.corrections.every(correction => dropsMergedDepends(correction) || addsCompanion(correction))
}

export function admitCorrectionsNeedPerson(card: Pick<SlicedCard, 'corrections'>): boolean {
  return !card.corrections.every(addsCompanion)
}

function needsPerson(card: SlicedCard): boolean {
  return correctionsNeedPerson(card) || proposesRiskSlices(card) || card.slices.length > 0
}

export function awaitsConfirmation(cards: readonly SlicedCard[]): boolean {
  return cards.some(needsPerson)
}

export function confirmationOf(card: SlicedCard, autoConfirm: boolean): Confirmation {
  if (autoConfirm)
    return 'auto'
  return needsPerson(card) ? tokenConfirmation() : 'none'
}
