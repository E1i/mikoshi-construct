import type { DatabaseSync } from 'node:sqlite'
import type { Card } from '../../src/card/grammar.js'
import type { ParkedTask } from '../../src/card/parking.js'
import type { EventRow, ReviewRow } from '../core/events-query.js'
import type { Queue } from '../core/identifiers.js'
import type { CleanUpdate } from '../nodes/update/update-done.js'
import type { InForceDecision } from './decisions/index.js'
import { cardLine } from '../../src/card/grammar.js'
import { parkingFileText, parseParkingFile } from '../../src/card/parking.js'
import { RISK_PREFIX, riskReading, SEAM_PREFIX, SLICE_DEPENDS, SLICE_PREFIX } from '../../src/card/risk.js'
import { witnessesOf } from '../../src/card/witness-fields.js'
import { AMEND_SOURCE } from '../../src/commands/intake/admit.js'
import { WITNESSES_HEADING } from '../../src/commands/intake/slice.js'
import { all, bodiesAdmittedBySource, bodiesAdmittedBySourceForAPr, EITHER_JOURNAL, ofPr, reviewsOfPr } from '../core/events-query.js'
import { PR_OBSERVED, PR_OPENED, REVIEW_RECORDED, REVIEW_ROUNDS_SPENT, ROUND_EXTENDED, ROUND_MUTATIONS_PARKED, SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED } from '../core/events.js'
import { REVIEW_ROUNDS } from '../core/identifiers.js'
import { INTAKE_ACTOR_PREFIX } from '../intake/admissions.js'
import { cleanUpdatesOf } from '../nodes/update/update-done.js'
import { isFullSha } from '../ports/identifier-shapes.js'
import { OWNER_SOURCE } from './decisions/decisions.js'
import { DECISIONS_SCOPE, decisionsInForceAt } from './shards.js'
import { createdPaths } from './touch-scope.js'

export const RECUT_SOURCE = 'round-limit-recut'
export const RECUT_ACTOR = `${INTAKE_ACTOR_PREFIX}${RECUT_SOURCE}`

const OWNER_DECISION = 'owner'
const OWNER_EVEN_PAST_THE_LIMIT = 'R1'
const OWNER_PREFIX = `${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} `

const ALLOW_MERGE = 'allow-merge'
export const CONTINUE_FIXES = 'continue-fixes'

function namesPrAtHeadUnder(marker: string, text: string, pr: number, head: string): boolean {
  return new RegExp(`^(?:${OWNER_PREFIX})?${marker} PR #${pr} at ${head}(?![0-9a-f])`).test(text)
}

export function namesPrAtHead(text: string, pr: number, head: string): boolean {
  return namesPrAtHeadUnder(ALLOW_MERGE, text, pr, head)
}

export function allowMergeOfPrAtHead(pr: number, head: string): string {
  return `${ALLOW_MERGE} PR #${pr} at ${head}`
}

function headsOf(rows: readonly EventRow[]): string[] {
  return rows.flatMap(row => row.head === null ? [] : [row.head])
}

export function observedHeadsOf(db: DatabaseSync, pr: number): string[] {
  const heads = headsOf(ofPr(db, pr, { types: [PR_OPENED, PR_OBSERVED] }))
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
export const PARKED_MUTATION_PREFIX = 'surviving mutation to kill: '
const CARD_HEADER = 'card: '
const FINDINGS_SUFFIX = '-findings'
const FINDINGS_SIZE = 'S'
const MUTATIONS_SUFFIX = '-mutations'
const MUTATIONS_SIZE = 'XS'
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
    | ParkPlan

export interface RecutCard {
  id: number
  text: string
}

export interface ParkPlan {
  kind: 'park'
  parked: ParkedTask
  mutations: readonly string[]
  continuation: RecutCard | null
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
  if (plan.kind === 'park')
    return plan.continuation === null ? 1 : 0
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

function mutationWitness(mutation: string): string {
  return `${PARKED_MUTATION_PREFIX}${mutation.replace(/`/g, '\'').replace(/\s+/g, ' ').trim()}`
}

function withWitnesses(text: string, added: readonly string[]): string {
  const lines = text.trimEnd().split('\n')
  const items = added.map(witness => `- ${witness}`)
  const at = lines.findIndex(line => line.trim() === WITNESSES_HEADING)
  if (at === -1)
    return `${[...lines, '', WITNESSES_HEADING, ...items].join('\n')}\n`
  const end = at + 1 + witnessesOf(text).length
  return `${[...lines.slice(0, end), ...items, ...lines.slice(end)].join('\n')}\n`
}

function parkedInto(plan: ParkPlan, pr: number, newId: number): Recut {
  const { task, who } = plan.parked
  const { card } = task
  const witnesses = plan.mutations.map(mutationWitness)
  if (plan.continuation !== null) {
    const carrier = { id: plan.continuation.id, text: withWitnesses(plan.continuation.text, witnesses) }
    return { admitted: [carrier], added: [], carrier, dropsTheCard: false }
  }
  const carrier = {
    id: newId,
    text: parkingFileText({
      card: cardLine({ ...card, id: newId, name: `${card.name}${MUTATIONS_SUFFIX}`, size: MUTATIONS_SIZE, depends: [card.id], blocks: [] }),
      branch: `${task.branch}${MUTATIONS_SUFFIX}`,
      touches: task.touches,
      continue: task.continue,
      who,
      body: withWitnesses(`Surviving mutations parked from card #${card.id} at ${ROUND_LIMIT} on PR #${pr}: each needs a test that kills it.`, witnesses),
    }),
  }
  return { admitted: [carrier], added: [newId], carrier, dropsTheCard: false }
}

export function recutOf(plan: Exclude<RecutPlan, { kind: 'owner_wait' }>, text: string, pr: number, firstId: number): Recut {
  if (plan.kind === 'park')
    return parkedInto(plan, pr, firstId)
  return plan.kind === 'narrow' ? narrowed(plan, text, pr, firstId) : sliced(plan, pr, firstId)
}

function coversTheTouches(candidate: RecutCard, touches: readonly string[]): boolean {
  const parsed = parseParkingFile(`${candidate.id}.md`, candidate.text)
  return parsed.kind === 'parked' && touches.every(touch => parsed.parked.task.touches.includes(touch))
}

export function parkPlanOf(cardId: number, text: string, mutations: readonly string[], dependents: readonly RecutCard[]): ParkPlan | Extract<RecutPlan, { kind: 'owner_wait' }> {
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind === 'refused')
    return { kind: 'owner_wait', why: `the body of card #${cardId} does not parse: ${parsed.reason}` }
  const continuation = dependents.find(dependent => coversTheTouches(dependent, parsed.parked.task.touches)) ?? null
  return { kind: 'park', parked: parsed.parked, mutations, continuation }
}

export type LimitRule
  = | { kind: 'park', mutations: string[] }
    | { kind: 'extend', findings: string[], previous: string[] }
    | { kind: 'owner' }

export interface LimitReading {
  decisionsShard: boolean
  findings: readonly string[]
  survivingMutations: readonly string[]
  previous: readonly string[]
  extendedBefore: boolean
}

function trimmedSet(list: readonly string[]): Set<string> {
  return new Set(list.map(each => each.trim()))
}

export function sameFindings(left: readonly string[], right: readonly string[]): boolean {
  const [one, other] = [trimmedSet(left), trimmedSet(right)]
  return one.size === other.size && [...one].every(finding => other.has(finding))
}

export function limitRuleOf(reading: LimitReading): LimitRule {
  if (!reading.decisionsShard)
    return { kind: 'owner' }
  const findings = [...trimmedSet(reading.findings)]
  const marked = trimmedSet(reading.survivingMutations)
  if (findings.length > 0 && findings.every(finding => marked.has(finding)))
    return { kind: 'park', mutations: findings }
  if (reading.extendedBefore || sameFindings(reading.findings, reading.previous))
    return { kind: 'owner' }
  return { kind: 'extend', findings, previous: [...trimmedSet(reading.previous)] }
}

function decisionUnder(marker: string, decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  if (!isFullSha(head))
    return null
  const heads = headsWithTheSameDiff(head, cleanUpdates)
  return decisions.find(decision => heads.some(decided => namesPrAtHeadUnder(marker, decision.text, pr, decided)))?.decisionId ?? null
}

export function roundLimitDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  return decisionUnder(ALLOW_MERGE, decisions, pr, head, cleanUpdates)
}

export interface MutationParking {
  id: number
  head: string
}

export function mutationsParkedGrantOf(parkings: readonly MutationParking[], head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  if (!isFullSha(head))
    return null
  const heads = headsWithTheSameDiff(head, cleanUpdates)
  return parkings.find(parking => heads.includes(parking.head))?.id ?? null
}

export function continueFixesDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  return decisionUnder(CONTINUE_FIXES, decisions, pr, head, cleanUpdates)
}

export interface PushHistory {
  observedHeads: readonly string[]
  cleanUpdates: readonly CleanUpdate[]
  changesHeads: ReadonlySet<string>
}

export function pushedAfterContinueFixes(decisions: readonly InForceDecision[], pr: number, head: string, history: PushHistory): boolean {
  const { observedHeads, cleanUpdates, changesHeads } = history
  const continued = (each: string): boolean => continueFixesDecisionOf(decisions, pr, each, cleanUpdates) !== null
  if (!isFullSha(head) || continued(head))
    return false
  const before = observedHeads.slice(0, Math.max(observedHeads.lastIndexOf(head), 0))
  const sinceTheLastContinue = [...before].reverse()
  const last = sinceTheLastContinue.findIndex(continued)
  return last !== -1 && sinceTheLastContinue.slice(0, last).every(each => !changesHeads.has(each))
}

export { REVIEWS_OF_A_PR } from '../core/events-query.js'

export type RoundReview = ReviewRow

export const BODIES_OWNER_AMENDED_FOR_A_PR = bodiesAdmittedBySourceForAPr(AMEND_SOURCE)

function bodyThePreviousHeadWasFirstReviewedUnder(reviews: readonly RoundReview[], at: number): unknown {
  const earlier = reviews.slice(0, at).filter(review => review.head !== reviews[at]!.head)
  const previous = earlier.at(-1)
  return previous === undefined ? null : earlier.find(review => review.head === previous.head)!.card_body
}

export function ownerAmendedSinceThePreviousReview(reviews: readonly RoundReview[], at: number, ownerAmended: ReadonlySet<string>): boolean {
  const before = bodyThePreviousHeadWasFirstReviewedUnder(reviews, at)
  const now = reviews[at]!.card_body
  return typeof before === 'string' && typeof now === 'string' && before !== now && ownerAmended.has(now)
}

export function roundsOf(reviews: readonly RoundReview[], ownerAmended: ReadonlySet<string>): number {
  const heads = new Set<string | null>()
  let rounds = 0
  for (const [at, review] of reviews.entries()) {
    if (review.verdict !== 'changes' || heads.has(review.head))
      continue
    heads.add(review.head)
    if (!ownerAmendedSinceThePreviousReview(reviews, at, ownerAmended))
      rounds += 1
  }
  return rounds
}

export const REPEAT_FINDINGS = 'repeat_findings'
const JSON_TRUE: readonly unknown[] = [1, true]

function repeatStopOnHead(db: DatabaseSync, pr: number, head: string | null): boolean {
  return ofPr(db, pr, { types: [REVIEW_ROUNDS_SPENT] }).some(row => row.head === head && row.data?.state === REPEAT_FINDINGS)
}

function shardEnded(ended: EventRow, issued: EventRow, extended: EventRow): boolean {
  return ended.id < extended.id && (ended.type === SHARD_REVOKED || ended.type === SHARD_EXPIRED) && ended.data?.id === issued.data?.id
}

function windowDecisionsShardLiveAt(shards: readonly EventRow[], extended: EventRow): boolean {
  const until = (issued: EventRow): unknown => issued.data?.until
  return shards.some(issued => issued.type === SHARD_ISSUED && issued.id < extended.id && JSON_TRUE.includes(issued.data?.window)
    && issued.data?.scope === DECISIONS_SCOPE && typeof until(issued) === 'string' && extended.ts !== null && (until(issued) as string) > extended.ts
    && !shards.some(ended => shardEnded(ended, issued, extended)))
}

function greenCiOnTheExtendedHead(observed: readonly EventRow[], extended: EventRow): boolean {
  const seen = observed.filter(row => row.id < extended.id).at(-1)
  return seen !== undefined && extended.head !== null && seen.head === extended.head && seen.data?.ci === 'green'
}

function findingsIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((finding): finding is string => typeof finding === 'string') : []
}

function raisesNewFindings(extended: EventRow): boolean {
  const findings = findingsIn(extended.data?.findings)
  return findings.length > 0 && !sameFindings(findings, findingsIn(extended.data?.previous))
}

function extensionsOf(db: DatabaseSync, pr: number): number {
  const extensions = ofPr(db, pr, { types: [ROUND_EXTENDED] })
  if (extensions.length === 0)
    return 0
  const shards = all(db, [SHARD_ISSUED, SHARD_REVOKED, SHARD_EXPIRED], { legacy: EITHER_JOURNAL })
  const observed = ofPr(db, pr, { types: [PR_OBSERVED] })
  return extensions.filter(extended => windowDecisionsShardLiveAt(shards, extended) && greenCiOnTheExtendedHead(observed, extended) && raisesNewFindings(extended)).length
}

export function changesRoundsOf(db: DatabaseSync, pr: number, next?: RoundReview): number {
  const ownerAmended = bodiesAdmittedBySource(db, BODIES_OWNER_AMENDED_FOR_A_PR, pr)
  const counted = [...reviewsOfPr(db, pr), ...(next === undefined ? [] : [next])]
  const rounds = roundsOf(counted, ownerAmended) - extensionsOf(db, pr)
  return repeatStopOnHead(db, pr, counted.at(-1)?.head ?? null) ? Math.max(rounds, REVIEW_ROUNDS) : rounds
}

const ROUND_LIMITED: readonly Queue[] = ['review', 'answer', 'merge']

export function outOfRounds(db: DatabaseSync, queue: Queue, pr: number | null): boolean {
  return ROUND_LIMITED.includes(queue) && pr !== null && changesRoundsOf(db, pr) >= REVIEW_ROUNDS
}

function mutationParkingsOf(db: DatabaseSync, pr: number): MutationParking[] {
  return ofPr(db, pr, { types: [ROUND_MUTATIONS_PARKED] }).flatMap(row => row.head === null ? [] : [{ id: row.id, head: row.head }])
}

export function mergeDecidedPastRoundLimit(db: DatabaseSync, ts: string, pr: number | null, head: string | null): number | null {
  if (pr === null || head === null || !outOfRounds(db, 'merge', pr))
    return null
  const cleanUpdates = cleanUpdatesOf(db, pr)
  return roundLimitDecisionOf(decisionsInForceAt(db, new Date(ts)), pr, head, cleanUpdates) ?? mutationsParkedGrantOf(mutationParkingsOf(db, pr), head, cleanUpdates)
}

function changesHeadsOf(db: DatabaseSync, pr: number): Set<string> {
  return new Set(headsOf(ofPr(db, pr, { types: [REVIEW_RECORDED] }).filter(row => row.data?.verdict === 'changes')))
}

function continuedPastRoundLimit(db: DatabaseSync, ts: string, queue: Queue, pr: number, head: string | null): boolean {
  if (head === null)
    return false
  const decisions = decisionsInForceAt(db, new Date(ts))
  const cleanUpdates = cleanUpdatesOf(db, pr)
  if (queue === 'answer')
    return continueFixesDecisionOf(decisions, pr, head, cleanUpdates) !== null
  return pushedAfterContinueFixes(decisions, pr, head, { observedHeads: observedHeadsOf(db, pr), cleanUpdates, changesHeads: changesHeadsOf(db, pr) })
}

export function closedByRounds(db: DatabaseSync, ts: string, queue: Queue, pr: number | null, head: string | null): boolean {
  if (pr === null || !outOfRounds(db, queue, pr))
    return false
  if (queue === 'merge' && mergeDecidedPastRoundLimit(db, ts, pr, head) !== null)
    return false
  return !continuedPastRoundLimit(db, ts, queue, pr, head)
}

export function mayRequeueUnderTheRounds(db: DatabaseSync, ts: string, task: { queue: Queue, pr: number | null, head: string | null }): boolean {
  return !closedByRounds(db, ts, task.queue, task.pr, task.head)
}
