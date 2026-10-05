import type { Contour, Decision, Kind, Milestone, Size } from '../../card/grammar.js'
import type { CheckedCard, Correction } from './check.js'
import type { DraftCard, UnclearField } from './draft.js'
import { seamLines, splitSignal } from '../../card/complexity.js'
import { cardLine } from '../../card/grammar.js'
import { parkingFileText, parseParkingFile, WINDOW_WHO } from '../../card/parking.js'
import { riskLines, riskReading } from '../../card/risk.js'
import { CARD_REFERENCE, correctionText, DEFAULT_CONTOUR } from './check.js'

export interface SlicedCard {
  id: number
  file: string
  line: string
  who: string
  unclear: UnclearField[]
  corrections: Correction[]
  seam: string[]
  risk: string[]
  text: string
}

export type Slice = { kind: 'sliced', cards: SlicedCard[] } | { kind: 'refused', reasons: string[] }

export const UNCLEAR_PREFIX = 'unclear: '
export const CORRECTED_PREFIX = 'corrected: '
export const WITNESSES_HEADING = 'Witnesses:'
const DEFAULT_IMPLEMENT_DECISION = 'owner'
const PROBE_DECISION = 'none'
const DEFAULT_CONTINUE = 'stop'

function defaulted(card: DraftCard): { contour: string, decision: string, unclear: UnclearField[] } {
  const unclear = [...card.unclear]
  const contour = card.contour ?? DEFAULT_CONTOUR
  if (card.contour === undefined)
    unclear.push({ field: 'contour', reason: `not stated in the retelling; set to ${DEFAULT_CONTOUR}, the path with a brief and witnesses` })
  let decision = card.decision
  if (decision === undefined && card.kind === 'probe')
    decision = PROBE_DECISION
  if (decision === undefined) {
    decision = DEFAULT_IMPLEMENT_DECISION
    unclear.push({ field: 'decision', reason: `not stated in the retelling; set to ${DEFAULT_IMPLEMENT_DECISION}, so the owner merges` })
  }
  return { contour, decision, unclear }
}

function resolve(references: readonly string[], ids: ReadonlyMap<string, number>, at: string, reasons: string[]): number[] {
  return references.flatMap((reference) => {
    const number = CARD_REFERENCE.exec(reference)?.[1]
    const id = number === undefined ? ids.get(reference) : Number(number)
    if (id === undefined)
      reasons.push(`${at}: '${reference}' names no card of this draft and is not '#<id>'`)
    return id === undefined ? [] : [id]
  })
}

function bodyOf(card: CheckedCard, unclear: readonly UnclearField[], seam: readonly string[], risk: readonly string[]): string {
  const notes = [
    ...unclear.map(entry => `${UNCLEAR_PREFIX}${entry.field} — ${entry.reason}`),
    ...card.corrections.map(correction => `${CORRECTED_PREFIX}${correctionText(correction)}`),
    ...seam,
    ...risk,
  ]
  return [
    card.task.trim(),
    '',
    WITNESSES_HEADING,
    ...card.witnesses.map(witness => `- ${witness.trim()}`),
    ...(notes.length === 0 ? [] : ['', ...notes]),
  ].join('\n')
}

function sorted(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

export function sliceCards(cards: readonly CheckedCard[], numbers: readonly number[]): Slice {
  const ids = new Map(cards.map((card, index) => [card.name, numbers[index]!]))
  const reasons: string[] = []
  const depends = cards.map(card => resolve(card.depends, ids, card.name, reasons))
  const blocks = cards.map(card => resolve(card.blocks, ids, card.name, reasons))
  const sliced = cards.map((card, index) => {
    const id = numbers[index]!
    const blockedHere = cards.flatMap((_, at) => (depends[at]!.includes(id) ? [numbers[at]!] : []))
    const { contour, decision, unclear } = defaulted(card)
    const line = cardLine({
      id,
      name: card.name,
      kind: card.kind as Kind,
      milestone: card.milestone as Milestone,
      size: card.size as Size,
      contour: contour as Contour,
      decision: decision as Decision,
      depends: sorted(depends[index]!),
      blocks: sorted([...blocks[index]!, ...blockedHere]),
    })
    const split = splitSignal({ touches: card.touches, unclear: unclear.length })
    const seam = seamLines(split)
    const reading = riskReading(card.touches, split.slices.length > 0)
    const risk = riskLines(reading)
    const who = unclear.length > 0 || split.split || reading.slices.length > 0 ? WINDOW_WHO : (card.who ?? WINDOW_WHO)
    const file = `${id}.md`
    const text = parkingFileText({
      card: line,
      branch: card.branch ?? `${card.kind === 'probe' ? 'probe' : 'feat'}/${card.name}`,
      touches: card.touches.map(entry => entry.trim()),
      continue: card.continue ?? DEFAULT_CONTINUE,
      who,
      body: bodyOf(card, unclear, seam, risk),
    })
    const parsed = parseParkingFile(file, text)
    if (parsed.kind === 'refused')
      reasons.push(`${card.name}: ${parsed.reason}`)
    return { id, file, line, who, unclear, corrections: card.corrections, seam, risk, text }
  })
  return reasons.length > 0 ? { kind: 'refused', reasons } : { kind: 'sliced', cards: sliced }
}
