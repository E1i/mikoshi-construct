import type { Contour, Decision, Kind, Milestone, Size } from '../../card/grammar.js'
import type { SliceSources } from '../../card/slice-depends.js'
import type { CheckedCard, Correction } from './check.js'
import type { DraftCard, UnclearField } from './draft.js'
import { seamLines, splitSignal } from '../../card/complexity.js'
import { cardLine } from '../../card/grammar.js'
import { createdPaths, parkingFileText, parseParkingFile, WINDOW_WHO } from '../../card/parking.js'
import { riskLines, riskReading, SLICE_PREFIX, TEST_SUFFIX } from '../../card/risk.js'
import { dependsCycle, sliceDepends } from '../../card/slice-depends.js'
import { CARD_REFERENCE, correctionText, DEFAULT_CONTOUR } from './check.js'

export interface CardSlice {
  touches: string[]
  depends: number[]
}

export interface SlicedCard {
  id: number
  file: string
  line: string
  who: string
  unclear: UnclearField[]
  corrections: Correction[]
  seam: string[]
  risk: string[]
  slices: CardSlice[]
  text: string
}

export type Slice = { kind: 'sliced', cards: SlicedCard[] } | { kind: 'refused', reasons: string[] }

export const UNCLEAR_PREFIX = 'unclear: '
export const CORRECTED_PREFIX = 'corrected: '
export const WITNESSES_HEADING = 'Witnesses:'
export const WHOLE_PREFIX = 'whole: '
const DEFAULT_IMPLEMENT_DECISION = 'owner'
const PROBE_DECISION = 'none'
const DEFAULT_CONTINUE = 'stop'
const SLICE_NAME_INFIX = '-slice-'

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
    ...(card.whole === undefined ? [] : [`${WHOLE_PREFIX}${card.whole.trim()}`]),
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

function slicedByItsText(card: CheckedCard): boolean {
  return card.task.split('\n').some(line => line.trim().startsWith(SLICE_PREFIX))
}

function sorted(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

export function sliceCards(cards: readonly CheckedCard[], numbers: readonly number[], sources: SliceSources): Slice {
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
    const split = splitSignal({ touches: card.touches, unclear: unclear.length, covering: card.covering })
    const reading = riskReading(card.touches, split.slices.length > 0)
    const proposed = [...split.slices, ...reading.slices].map(slice => slice.touches)
    const order = sliceDepends(proposed, sources)
    const seam = seamLines(split, order)
    const risk = riskLines(reading, order)
    const heldForSlicing = card.whole === undefined && proposed.length > 0
    if (heldForSlicing && slicedByItsText(card))
      reasons.push(`${card.name}: the task text names its own slices and the seam proposes others; a card has one source of slicing, so cut the draft into the cards its text names, or drop the '${SLICE_PREFIX.trim()}' lines from the task`)
    const cycle = heldForSlicing ? dependsCycle(order) : null
    if (cycle !== null)
      reasons.push(`${card.name}: slices ${cycle.map(at => at + 1).join(', ')} import each other, so no order of their cards holds; keep the card whole with 'whole:' or cut the draft by hand`)
    const slices = heldForSlicing ? proposed.map((touches, at) => ({ touches, depends: order[at]! })) : []
    const who = unclear.length > 0 || heldForSlicing ? WINDOW_WHO : (card.who ?? WINDOW_WHO)
    const file = `${id}.md`
    const text = parkingFileText({
      card: line,
      branch: card.branch ?? `${card.kind === 'probe' ? 'probe' : 'feat'}/${card.name}`,
      touches: card.touches.map(entry => entry.trim()),
      creates: card.creates,
      continue: card.continue ?? DEFAULT_CONTINUE,
      who,
      body: bodyOf(card, unclear, seam, risk),
    })
    const parsed = parseParkingFile(file, text)
    if (parsed.kind === 'refused')
      reasons.push(`${card.name}: ${parsed.reason}`)
    return { id, file, line, who, unclear, corrections: card.corrections, seam, risk, slices, text }
  })
  return reasons.length > 0 ? { kind: 'refused', reasons } : { kind: 'sliced', cards: sliced }
}

function sliceName(card: CheckedCard, at: number): string {
  return `${card.name}${SLICE_NAME_INFIX}${at + 1}`
}

function witnessesOfSlice(witnesses: readonly string[], touches: readonly string[], everyTouch: readonly string[]): string[] {
  const names = (witness: string, among: readonly string[]): boolean => among.some(touch => TEST_SUFFIX.test(touch) && witness.includes(touch))
  return witnesses.filter(witness => names(witness, touches) || !names(witness, everyTouch))
}

function slicedCard(card: CheckedCard, slice: CardSlice, at: number, dependents: (reference: string) => string[]): CheckedCard {
  const witnesses = witnessesOfSlice(card.witnesses, slice.touches, card.touches)
  const { number: _number, ...rest } = card
  return {
    ...rest,
    name: sliceName(card, at),
    ...(card.branch === undefined ? {} : { branch: `${card.branch}${SLICE_NAME_INFIX}${at + 1}` }),
    touches: slice.touches,
    creates: card.creates.filter(entry => createdPaths([entry]).some(created => slice.touches.includes(created))),
    depends: [...card.depends.flatMap(dependents), ...slice.depends.map(other => sliceName(card, other))],
    blocks: card.blocks.flatMap(dependents),
    whole: `slice ${at + 1} of ${card.name}`,
    witnesses: witnesses.length > 0 ? witnesses : card.witnesses,
    unclear: witnesses.length > 0 ? card.unclear : [...card.unclear, { field: 'witnesses', reason: `no witness of ${card.name} names a test of slice ${at + 1}; every witness of the card is kept until a person narrows them` }],
  }
}

export function cutSlices(cards: readonly CheckedCard[], sliced: readonly SlicedCard[]): CheckedCard[] {
  const cut = new Map(cards.flatMap((card, index) => (sliced[index]!.slices.length === 0 ? [] : [[card.name, sliced[index]!.slices.map((_, at) => sliceName(card, at))] as const])))
  const dependents = (reference: string): string[] => cut.get(reference) ?? [reference]
  return cards.flatMap((card, index) => {
    const { slices } = sliced[index]!
    if (slices.length === 0)
      return [{ ...card, depends: card.depends.flatMap(dependents), blocks: card.blocks.flatMap(dependents) }]
    return slices.map((slice, at) => slicedCard(card, slice, at, dependents))
  })
}
