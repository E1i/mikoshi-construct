import type { DatabaseSync } from 'node:sqlite'
import type { EventRow, EventsQuery } from '../../core/events-query.js'
import type { CarriedTree, Lease } from '../../core/lease.js'
import type { PrRow } from '../../core/pr-readings.js'
import type { InForceDecision } from '../../policy/decisions/index.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { cardSessionsIn } from '../../core/card-bodies.js'
import { cardHoldOf } from '../../core/card-hold.js'
import { admittedBodyOf, standingStopOf } from '../../core/card-readings.js'
import { EITHER_JOURNAL, events as eventsOf, latest } from '../../core/events-query.js'
import { CARD_STARTED, PR_OBSERVED, QUESTION_AGENT, QUESTION_OWNER, REVIEW_RECORDED, TASK_COMPLETED, TASK_FAILED, TASK_RELEASED, TASK_SUPERSEDED } from '../../core/events.js'
import { decisionOfKey } from '../../core/identifiers.js'
import { TREE_CARRIER_QUEUE } from '../../core/lease.js'
import * as prs from '../../core/pr-readings.js'
import { decisionRecordedAfter } from '../../policy/decisions/index.js'
import { cardDecisionLines, decisionsInForceAt } from '../../policy/shards.js'

export { cardDecisionLines as boundDecisionLines } from '../../policy/shards.js'

export const LATEST_EVENTS = 20

export interface CardEvent {
  id: number
  ts: string
  type: string
  payload: unknown
}

export interface WideningRequest {
  paths: string[]
}

export type AnswerSource
  = | { kind: 'question', detail: string, widen: WideningRequest | null, events: CardEvent[], decisions: string[] }
    | { kind: 'changes', findings: string[], failedChecks?: string[], events: CardEvent[], decisions: string[] }
    | { kind: 'ci', failedChecks: string[], events: CardEvent[], decisions: string[] }
    | { kind: 'decision', decisionId: number, text: string, events: CardEvent[], decisions: string[] }

export interface CardSession {
  session: string
  worktree: string
  branch: string
}

function dataOf(event: EventRow): Record<string, unknown> {
  return event.data ?? {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string' && each !== '') : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function latestEvents(db: DatabaseSync, cardId: number): CardEvent[] {
  const rows = eventsOf(db, { card: cardId, newestFirst: true, limit: LATEST_EVENTS })
  return rows.reverse().map(row => ({ id: row.id, ts: row.ts, type: row.type, payload: dataOf(row) }))
}

function openQuestion(db: DatabaseSync, cardId: number): Record<string, unknown> | null {
  const payload = standingStopOf(db, cardId)?.payload ?? null
  return payload?.reason === QUESTION_AGENT ? payload : null
}

function decisionsBoundTo(db: DatabaseSync, cardId: number, now: Date): InForceDecision[] {
  return decisionsInForceAt(db, now).filter(decision => decision.cards.includes(cardId))
}

const QUESTION_REASONS: readonly unknown[] = [QUESTION_AGENT, QUESTION_OWNER]

function recordedAfter(db: DatabaseSync, decision: InForceDecision, eventId: number): boolean {
  return decisionRecordedAfter(db, decision.decisionId, eventId)
}

export function decisionAnsweringRepeat(db: DatabaseSync, cardId: number, question: string, now: Date): number | null {
  const stop = standingStopOf(db, cardId)
  if (stop === null || !QUESTION_REASONS.includes(stop.payload.reason) || text(stop.payload.detail)?.trim() !== question.trim())
    return null
  return decisionsBoundTo(db, cardId, now).find(decision => recordedAfter(db, decision, stop.id))?.decisionId ?? null
}

function widenOf(payload: Record<string, unknown>): WideningRequest | null {
  const paths = strings(payload.widen)
  return paths.length === 0 ? null : { paths }
}

const CHANGES = 'changes'
const RED = 'red'

function prAtHead(db: DatabaseSync, pr: number, head: string): PrRow | null {
  const row = prs.ofPr(db, pr)
  return row?.head === head ? row : null
}

function newestWith(db: DatabaseSync, query: EventsQuery, field: string, value: string): Record<string, unknown> | null {
  const found = eventsOf(db, { ...query, legacy: EITHER_JOURNAL, newestFirst: true }).find(event => dataOf(event)[field] === value)
  return found === undefined ? null : dataOf(found)
}

function changesOn(db: DatabaseSync, lease: Lease): string[] | null {
  if (lease.pr === null || lease.head === null)
    return null
  if (prAtHead(db, lease.pr, lease.head)?.verdict_on_head !== CHANGES)
    return null
  const review = newestWith(db, { types: [REVIEW_RECORDED], card: lease.cardId, head: lease.head }, 'verdict', CHANGES)
  return review === null ? [] : strings(review.findings)
}

export function failedChecksOn(db: DatabaseSync, lease: Lease): string[] | null {
  if (lease.pr === null || lease.head === null)
    return null
  if (prAtHead(db, lease.pr, lease.head)?.ci !== RED)
    return null
  const observed = newestWith(db, { types: [PR_OBSERVED], pr: lease.pr, head: lease.head }, 'ci', RED)
  return observed === null ? [] : strings(observed.failed_checks)
}

export function answerSourceOf(db: DatabaseSync, lease: Lease, now: Date = new Date()): AnswerSource | null {
  const events = latestEvents(db, lease.cardId)
  const decisions = cardDecisionLines(db, lease.cardId, now)
  const decided = decisionOfKey(lease.taskKey)
  const decision = decided === undefined ? undefined : decisionsInForceAt(db, now).find(each => each.decisionId === decided)
  if (decision !== undefined)
    return { kind: 'decision', decisionId: decision.decisionId, text: decision.text, events, decisions }
  const question = openQuestion(db, lease.cardId)
  if (question !== null)
    return { kind: 'question', detail: text(question.detail) ?? '', widen: widenOf(question), events, decisions }
  const findings = changesOn(db, lease)
  const failedChecks = failedChecksOn(db, lease)
  if (findings !== null)
    return { kind: 'changes', findings, ...(failedChecks === null ? {} : { failedChecks }), events, decisions }
  return failedChecks === null ? null : { kind: 'ci', failedChecks, events, decisions }
}

export interface AdmittedScope {
  admission: number
  touches: string[]
  creates: string[]
}

export function admittedScopeOf(db: DatabaseSync, cardId: number): AdmittedScope | null {
  const body = admittedBodyOf(db, cardId)
  return body === null ? null : { admission: body.admission_event_id, touches: strings(body.touches), creates: strings(body.creates) }
}

export const NO_RECORDED_SESSION = ''
export const START_LINE = 'path'

function startedOf(db: DatabaseSync, cardId: number): CardSession | null {
  const row = latest(db, { card: cardId, types: [CARD_STARTED] })
  if (row === null)
    return null
  const payload = dataOf(row)
  const started = text(payload.session)
  const worktree = text(payload.worktree)
  const branch = text(payload.branch)
  if (started === null || worktree === null || branch === null)
    return null
  return { session: cardSessionsIn(BUS_CONTRACT, db, cardId).at(-1) ?? started, worktree, branch }
}

function chainSessionOf(payload: Record<string, unknown>): string {
  const windowSession = text(payload.shift) === null
  return windowSession ? NO_RECORDED_SESSION : text(payload.session) ?? NO_RECORDED_SESSION
}

function namesATree(payload: Record<string, unknown>): boolean {
  return typeof payload.worktree === 'string' && typeof payload.branch === 'string'
}

function startLineOf(db: DatabaseSync, cardId: number): CardSession | null {
  const row = eventsOf(db, { card: cardId, types: [START_LINE], legacy: true, newestFirst: true }).find(line => namesATree(dataOf(line)))
  if (row === undefined)
    return null
  const payload = dataOf(row)
  const worktree = text(payload.worktree)
  const branch = text(payload.branch)
  return worktree === null || branch === null ? null : { session: chainSessionOf(payload), worktree, branch }
}

export function cardSessionOf(db: DatabaseSync, cardId: number): CardSession | null {
  return startedOf(db, cardId) ?? startLineOf(db, cardId)
}

const OPEN_PR = 'open'
const DRAFT = 1

function openPrsOf(db: DatabaseSync, cardId: number): PrRow[] {
  return prs.ofCard(db, cardId).filter(row => row.state === OPEN_PR)
}

export function ownerHoldOf(db: DatabaseSync, cardId: number): string | null {
  const hold = cardHoldOf(db, cardId)
  if (hold !== null)
    return hold
  const draft = openPrsOf(db, cardId).filter(row => row.draft === DRAFT).at(-1)
  return draft === undefined ? null : `card #${cardId} has the draft pull request #${draft.pr}, which is the owner's until it is marked ready`
}

function treeOf(value: unknown): CarriedTree | null {
  if (value === null || typeof value !== 'object')
    return null
  const { path, head, localCommits, dirty } = value as Record<string, unknown>
  return typeof path === 'string' && typeof head === 'string' && typeof dirty === 'boolean' ? { path, head, localCommits: strings(localCommits), dirty } : null
}

const ENDS_OF_A_CARRIER = [TASK_COMPLETED, TASK_FAILED, TASK_SUPERSEDED, TASK_RELEASED]

function isObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function carriesOrOwnsTheTree(event: EventRow): boolean {
  const payload = dataOf(event)
  return payload.queue === TREE_CARRIER_QUEUE && (event.type !== TASK_RELEASED || isObject(payload.tree))
}

export function carriedTreeOf(db: DatabaseSync, cardId: number): CarriedTree | null {
  const last = eventsOf(db, { card: cardId, types: ENDS_OF_A_CARRIER, newestFirst: true }).find(carriesOrOwnsTheTree)
  return last === undefined ? null : treeOf(dataOf(last).tree)
}

export function openPrOfCard(db: DatabaseSync, cardId: number): number | null {
  return openPrsOf(db, cardId).at(-1)?.pr ?? null
}

export function openPrHeadOf(db: DatabaseSync, pr: number): string | null {
  return prs.headOf(db, pr)
}
