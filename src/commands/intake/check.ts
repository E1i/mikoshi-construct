import type { Kind } from '../../card/grammar.js'
import type { DraftCard, UnclearField } from './draft.js'
import type { RepositoryFacts } from './facts.js'
import { CONTOURS, decisionsOf, KINDS } from '../../card/grammar.js'
import { PREFIX_SUFFIX, touchError } from '../../card/task-file.js'
import { commandWord } from '../attach/harness.js'

export const DEFAULT_CONTOUR = 'ladder'
export const CARD_REFERENCE = /^#(\d+)$/
const BACKTICKED = /`([^`]+)`/g
const FIELD_ORDER = ['number', 'contour', 'decision', 'touches', 'creates', 'depends', 'blocks']

export interface Correction {
  field: string
  was: string
  now: string
  reason: string
}

export interface CheckedCard extends DraftCard {
  corrections: Correction[]
}

export interface CheckFacts {
  taken: ReadonlySet<number>
  parked: ReadonlySet<number>
  done: ReadonlySet<string>
  merged: ReadonlySet<string>
  repository: RepositoryFacts
}

export function correctionText(correction: Correction): string {
  return `${correction.field} — ${correction.was} → ${correction.now} — ${correction.reason}`
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value)
}

function numberCorrection(card: DraftCard, assigned: number, facts: CheckFacts): Correction[] {
  const named = card.number
  if (named === undefined || named === assigned)
    return []
  const reason = facts.taken.has(named)
    ? `#${named} is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake`
    : facts.parked.has(named)
      ? `#${named} is taken by the parked card ${named}.md; numbers are assigned by construct intake`
      : 'numbers are assigned by construct intake, the next free after every number taken; a named number is never used'
  return [{ field: 'number', was: `#${named}`, now: `#${assigned}`, reason }]
}

function contourCorrection(card: DraftCard): Correction[] {
  if (card.contour === undefined || includes(CONTOURS, card.contour))
    return []
  return [{ field: 'contour', was: card.contour, now: DEFAULT_CONTOUR, reason: `'${card.contour}' is not one of ${CONTOURS.join(', ')}; ${DEFAULT_CONTOUR} is the path with a brief and witnesses` }]
}

function decisionCorrection(card: DraftCard): Correction[] {
  if (card.decision === undefined || !includes(KINDS, card.kind))
    return []
  const decisions: readonly string[] = decisionsOf(card.kind as Kind)
  if (includes(decisions, card.decision))
    return []
  return [{ field: 'decision', was: card.decision, now: decisions[0]!, reason: `kind ${card.kind} takes decision ${decisions.join(' or ')}, not ${card.decision}` }]
}

function candidatesText(candidates: readonly string[]): string {
  return candidates.length === 0 ? 'no path is' : `${candidates.length} paths: ${candidates.join(', ')} are`
}

interface Touched {
  touches: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

function touchesChecked(card: DraftCard, repository: RepositoryFacts): Touched {
  const touched: Touched = { touches: [], corrections: [], unclear: [] }
  for (const entry of card.touches) {
    if (touchError(entry) !== null) {
      touched.touches.push(entry)
      continue
    }
    const created = card.creates.includes(entry)
    const prefix = entry.endsWith(PREFIX_SUFFIX) ? PREFIX_SUFFIX : ''
    const scope = prefix === '' ? entry : entry.slice(0, -PREFIX_SUFFIX.length)
    if (repository.exists(scope)) {
      touched.touches.push(entry)
      if (created)
        touched.corrections.push({ field: 'creates', was: entry, now: '(exists, not new)', reason: `${entry} already exists` })
      continue
    }
    const segment = scope.slice(scope.lastIndexOf('/') + 1)
    const candidates = created ? [] : repository.pathsNamed(segment)
    if (candidates.length === 1) {
      touched.touches.push(`${candidates[0]}${prefix}`)
      touched.corrections.push({ field: 'touches', was: entry, now: `${candidates[0]}${prefix}`, reason: `'${scope}' does not exist; '${candidates[0]}' is the only path named '${segment}'` })
      continue
    }
    touched.touches.push(entry)
    if (!created)
      touched.unclear.push({ field: 'touches', reason: `'${scope}' does not exist and ${candidatesText(candidates)} named '${segment}'; list it under creates if the change makes it` })
  }
  return touched
}

interface Linked {
  kept: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

function referencesChecked(field: 'depends' | 'blocks', references: readonly string[], facts: CheckFacts): Linked {
  const linked: Linked = { kept: [], corrections: [], unclear: [] }
  for (const reference of references) {
    const id = CARD_REFERENCE.exec(reference)?.[1]
    if (id === undefined) {
      linked.kept.push(reference)
    }
    else if (facts.merged.has(id)) {
      linked.corrections.push({ field, was: reference, now: '(removed)', reason: 'already merged' })
    }
    else {
      linked.kept.push(reference)
      if (!facts.parked.has(Number(id)) && !facts.done.has(id))
        linked.unclear.push({ field, reason: `'${reference}' is neither a parked card, done nor merged in the journal` })
    }
  }
  return linked
}

function witnessesUnclear(card: DraftCard, repository: RepositoryFacts): UnclearField[] {
  return card.witnesses.flatMap((witness) => {
    const words = [...witness.matchAll(BACKTICKED)].flatMap(match => commandWord(match[1]!) || [])
    if (words.length === 0)
      return [{ field: 'witnesses', reason: `'${witness.trim()}' names no command; a witness is run by a command` }]
    return [...new Set(words)]
      .filter(word => !repository.commandResolves(word))
      .map(word => ({ field: 'witnesses', reason: `'${word}' is not on PATH and is no file of the repository` }))
  })
}

function byFieldOrder(corrections: Correction[]): Correction[] {
  return [...corrections].sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))
}

function checkCard(card: DraftCard, assigned: number, facts: CheckFacts): CheckedCard {
  const touched = touchesChecked(card, facts.repository)
  const depends = referencesChecked('depends', card.depends, facts)
  const blocks = referencesChecked('blocks', card.blocks, facts)
  const contour = contourCorrection(card)
  const decision = decisionCorrection(card)
  return {
    ...card,
    contour: contour[0]?.now ?? card.contour,
    decision: decision[0]?.now ?? card.decision,
    touches: touched.touches,
    depends: depends.kept,
    blocks: blocks.kept,
    unclear: [
      ...card.unclear,
      ...touched.unclear,
      ...depends.unclear,
      ...blocks.unclear,
      ...witnessesUnclear(card, facts.repository),
    ],
    corrections: byFieldOrder([
      ...numberCorrection(card, assigned, facts),
      ...contour,
      ...decision,
      ...touched.corrections,
      ...depends.corrections,
      ...blocks.corrections,
    ]),
  }
}

export function checkDraft(cards: readonly DraftCard[], numbers: readonly number[], facts: CheckFacts): CheckedCard[] {
  return cards.map((card, index) => checkCard(card, numbers[index]!, facts))
}
