import type { DatabaseSync } from 'node:sqlite'
import type { Card } from '../../src/card/grammar.js'
import type { ParkedTask } from '../../src/card/parking.js'
import type { InForceDecision } from './decisions.js'
import type { CleanUpdate } from '../nodes/update/update-done.js'
import { cardLine } from '../../src/card/grammar.js'
import { createdPaths, parkingFileText, parseParkingFile } from '../../src/card/parking.js'
import { RISK_PREFIX, riskReading, SEAM_PREFIX, SLICE_DEPENDS, SLICE_PREFIX } from '../../src/card/risk.js'
import { witnessesOf } from '../../src/commands/intake/admit.js'
import { WITNESSES_HEADING } from '../../src/commands/intake/slice.js'
import { PR_OBSERVED, PR_OPENED } from '../core/events.js'
import { OWNER_SOURCE } from './decisions/decisions.js'
import { INTAKE_ACTOR_PREFIX } from '../intake/admissions.js'
import { isFullSha } from '../core/identifiers.js'

export const RECUT_SOURCE = 'round-limit-recut'
export const RECUT_ACTOR = `${INTAKE_ACTOR_PREFIX}${RECUT_SOURCE}`

const OWNER_DECISION = 'owner'
const OWNER_EVEN_PAST_THE_LIMIT = 'R1'
const OWNER_PREFIX = `${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} `

export function namesPrAtHead(text: string, pr: number, head: string): boolean {
  return new RegExp(`^(?:${OWNER_PREFIX})?allow-merge PR #${pr} at ${head}(?![0-9a-f])`).test(text)
}

const HEADS_OF_A_PR = `SELECT head FROM events WHERE type IN ('${PR_OPENED}', '${PR_OBSERVED}') AND legacy = 0 AND pr = ? AND head IS NOT NULL ORDER BY id`

export function observedHeadsOf(db: DatabaseSync, pr: number): string[] {
  const heads = (db.prepare(HEADS_OF_A_PR).all(pr) as { head: string }[]).map(row => row.head)
  return heads.filter((head, at) => at === 0 || heads[at - 1] !== head)
}

function headsWithTheSameDiff(head: string, cleanUpdates: readonly CleanUpdate[]): string[] {
  const heads = [head]
  for (let current = head; ;) {
    const from = cleanUpdates.find(update => update.to === current)?.from
    if (from === undefined || heads.includes(from))
      return heads
    heads.push(from)
    current = from
  }
}

function headObservedBefore(head: string, observedHeads: readonly string[]): string | undefined {
  const at = observedHeads.lastIndexOf(head)
  return at > 0 ? observedHeads[at - 1] : undefined
}

export function dryRunHoldsAt(dryRunHead: string, head: string, observedHeads: readonly string[], cleanUpdates: readonly CleanUpdate[]): boolean {
  if (!isFullSha(dryRunHead) || !isFullSha(head))
    return false
  return headsWithTheSameDiff(head, cleanUpdates).some(same => same === dryRunHead || headObservedBefore(same, observedHeads) === dryRunHead)
}

export const NARROWED_FINDINGS_AT_MOST = 2
export const NARROWED_PREFIX = 'narrowed: '
export const SLICED_PREFIX = 'sliced: '
const CARD_HEADER = 'card: '
const FINDINGS_SUFFIX = '-findings'
const FINDINGS_SIZE = 'S'
const ROUND_LIMIT = 'the review round limit (D-104)'
const PLACE = /([\w./-]+\.[a-z]+):([\w$]+)/g
const COMPLEXITY_SEAMS = ['complexity', 'volume']
const SLICE_LINE = new RegExp(`^${SLICE_PREFIX}(\\d+) [^—]* — (.+?)(?: ${SLICE_DEPENDS}([\\d, ]+))?$`)

export interface Place {
  finding: string
  file: string
  anchor: string
}

export interface ProposedSlice {
  index: number
  touches: string[]
  depends: number[]
}

export type RecutPlan
  = | { kind: 'owner_wait', why: string }
    | { kind: 'narrow', parked: ParkedTask, places: Place[] }
    | { kind: 'slice', parked: ParkedTask, slices: ProposedSlice[] }

export interface RecutCard {
  id: number
  text: string
}

export interface Recut {
  admitted: RecutCard[]
  added: number[]
  carrier: RecutCard
  dropsTheCard: boolean
}

export function placeOf(finding: string): Place | null {
  const places = [...new Map([...finding.matchAll(PLACE)].map(match => [`${match[1]}:${match[2]}`, { finding, file: match[1]!, anchor: match[2]! }])).values()]
  return places.length === 1 ? places[0]! : null
}

function touchesTheGoalWitness(place: Place, text: string): boolean {
  return witnessesOf(text).some(witness => witness.includes(place.file))
}

function narrowPlaces(findings: readonly string[], text: string): Place[] | null {
  if (findings.length === 0 || findings.length > NARROWED_FINDINGS_AT_MOST)
    return null
  const places = findings.map(placeOf)
  return places.every(place => place !== null && !touchesTheGoalWitness(place, text)) ? places as Place[] : null
}

function seamOf(line: string): string | null {
  return line.startsWith(SEAM_PREFIX) ? line.slice(SEAM_PREFIX.length).split(' ')[0]! : null
}

export function complexitySlicesOf(text: string): ProposedSlice[] {
  let seam: string | null = null
  const slices: ProposedSlice[] = []
  for (const line of text.split('\n').map(each => each.trim())) {
    seam = seamOf(line) ?? (line.startsWith(RISK_PREFIX) ? null : seam)
    const slice = SLICE_LINE.exec(line)
    if (slice === null || seam === null || !COMPLEXITY_SEAMS.includes(seam))
      continue
    const depends = (slice[3] ?? '').split(',').map(each => each.trim()).filter(each => each !== '').map(Number)
    slices.push({ index: Number(slice[1]), touches: slice[2]!.split(',').map(each => each.trim()), depends })
  }
  return slices
}

function sliceOrder(slices: readonly ProposedSlice[]): ProposedSlice[] | null {
  const ordered: ProposedSlice[] = []
  const placed = new Set<number>()
  while (ordered.length < slices.length) {
    const next = slices.find(slice => !placed.has(slice.index) && slice.depends.every(index => placed.has(index)))
    if (next === undefined)
      return null
    ordered.push(next)
    placed.add(next.index)
  }
  return ordered
}

export function recutPlanOf(cardId: number, text: string, findings: readonly string[]): RecutPlan {
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind === 'refused')
    return { kind: 'owner_wait', why: `the body of card #${cardId} does not parse: ${parsed.reason}` }
  const { parked } = parsed
  const { task } = parked
  if (task.card.decision === OWNER_DECISION)
    return { kind: 'owner_wait', why: `card #${cardId} is an owner card, so the owner decides past the round limit` }
  const risk = riskReading(task.touches, false)
  if (risk.level === OWNER_EVEN_PAST_THE_LIMIT)
    return { kind: 'owner_wait', why: `card #${cardId} is ${risk.level} (${risk.why}), so the owner decides past the round limit` }
  const places = narrowPlaces(findings, text)
  if (places !== null)
    return { kind: 'narrow', parked, places }
  const slices = sliceOrder(complexitySlicesOf(text))
  if (slices === null || slices.length < 2)
    return { kind: 'owner_wait', why: `card #${cardId} has open findings that do not narrow it and Shredder proposed no complexity slices of it` }
  return { kind: 'slice', parked, slices }
}

export function recutCardCount(plan: Exclude<RecutPlan, { kind: 'owner_wait' }>): number {
  return plan.kind === 'narrow' ? 1 : plan.slices.length
}

function withCard(text: string, card: Omit<Card, 'line'>): string {
  return text.split('\n').map(line => line.startsWith(CARD_HEADER) ? `${CARD_HEADER}${cardLine(card)}` : line).join('\n')
}

function beforeTheWitnesses(text: string, added: readonly string[]): string {
  const lines = text.trimEnd().split('\n')
  const at = lines.findIndex(line => line.trim() === WITNESSES_HEADING)
  return `${(at === -1 ? [...lines, '', ...added] : [...lines.slice(0, at), ...added, '', ...lines.slice(at)]).join('\n')}\n`
}

function narrowed(plan: Extract<RecutPlan, { kind: 'narrow' }>, text: string, pr: number, findingsId: number): Recut {
  const { task, who } = plan.parked
  const { card } = task
  const carrier = { id: card.id, text: beforeTheWitnesses(withCard(text, { ...card, blocks: [...card.blocks, findingsId] }), plan.places.map(place => `${NARROWED_PREFIX}${place.file}:${place.anchor} moved to card #${findingsId} at ${ROUND_LIMIT} on PR #${pr}: ${place.finding}`)) }
  const findings = {
    id: findingsId,
    text: parkingFileText({
      card: cardLine({ ...card, id: findingsId, name: `${card.name}${FINDINGS_SUFFIX}`, size: FINDINGS_SIZE, depends: [card.id], blocks: [] }),
      branch: `${task.branch}${FINDINGS_SUFFIX}`,
      touches: [...new Set(plan.places.map(place => place.file))],
      continue: task.continue,
      who,
      body: [`Findings cut from card #${card.id} at ${ROUND_LIMIT} on PR #${pr}:`, ...plan.places.map(place => `- ${place.finding}`)].join('\n'),
    }),
  }
  return { admitted: [carrier, findings], added: [findingsId], carrier, dropsTheCard: false }
}

function sliced(plan: Extract<RecutPlan, { kind: 'slice' }>, pr: number, firstId: number): Recut {
  const { task, who, creates } = plan.parked
  const { card } = task
  const idOf = (index: number): number => firstId + plan.slices.findIndex(slice => slice.index === index)
  const body = task.body.split('\n').filter(line => !line.trim().startsWith(SLICE_PREFIX)).join('\n')
  const cards = plan.slices.map((slice, at) => ({
    id: firstId + at,
    text: parkingFileText({
      card: cardLine({ ...card, id: firstId + at, name: `${card.name}-${slice.index}`, depends: [...card.depends, ...slice.depends.map(idOf)], blocks: [] }),
      branch: at === 0 ? task.branch : `${task.branch}-${slice.index}`,
      touches: slice.touches,
      creates: createdPaths(creates).filter(created => slice.touches.includes(created)),
      continue: task.continue,
      who,
      body: `${SLICED_PREFIX}slice ${slice.index} of card #${card.id}, cut at ${ROUND_LIMIT} on PR #${pr}\n\n${body}`,
    }),
  }))
  return { admitted: cards, added: cards.map(each => each.id), carrier: cards[0]!, dropsTheCard: true }
}

export function recutOf(plan: Exclude<RecutPlan, { kind: 'owner_wait' }>, text: string, pr: number, firstId: number): Recut {
  return plan.kind === 'narrow' ? narrowed(plan, text, pr, firstId) : sliced(plan, pr, firstId)
}

export function roundLimitDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  if (!isFullSha(head))
    return null
  const heads = headsWithTheSameDiff(head, cleanUpdates)
  return decisions.find(decision => heads.some(decided => namesPrAtHead(decision.text, pr, decided)))?.decisionId ?? null
}
