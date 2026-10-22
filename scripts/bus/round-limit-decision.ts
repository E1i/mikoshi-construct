import type { DatabaseSync } from 'node:sqlite'
import type { ShiftTask } from '../../src/card/task-file.js'
import type { InForceDecision } from './decisions.js'
import type { CleanUpdate } from './update-done.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { RISK_PREFIX, riskReading, SEAM_PREFIX, SLICE_DEPENDS, SLICE_PREFIX } from '../../src/card/risk.js'
import { witnessesOf } from '../../src/commands/intake/admit.js'
import { PR_OBSERVED, PR_OPENED } from '../core/events.js'
import { OWNER_SOURCE } from '../decisions/decisions.js'
import { isFullSha } from './identifiers.js'

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
    | { kind: 'narrow', task: ShiftTask, places: Place[] }
    | { kind: 'slice', task: ShiftTask, slices: ProposedSlice[] }

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
  const { task } = parsed.parked
  if (task.card.decision === OWNER_DECISION)
    return { kind: 'owner_wait', why: `card #${cardId} is an owner card, so the owner decides past the round limit` }
  const risk = riskReading(task.touches, false)
  if (risk.level === OWNER_EVEN_PAST_THE_LIMIT)
    return { kind: 'owner_wait', why: `card #${cardId} is ${risk.level} (${risk.why}), so the owner decides past the round limit` }
  const places = narrowPlaces(findings, text)
  if (places !== null)
    return { kind: 'narrow', task, places }
  const slices = sliceOrder(complexitySlicesOf(text))
  if (slices === null || slices.length < 2)
    return { kind: 'owner_wait', why: `card #${cardId} has open findings that do not narrow it and Shredder proposed no complexity slices of it` }
  return { kind: 'slice', task, slices }
}

export function roundLimitDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  if (!isFullSha(head))
    return null
  const heads = headsWithTheSameDiff(head, cleanUpdates)
  return decisions.find(decision => heads.some(decided => namesPrAtHead(decision.text, pr, decided)))?.decisionId ?? null
}
