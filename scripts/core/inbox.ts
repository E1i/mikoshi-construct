import type { DatabaseSync } from 'node:sqlite'
import type { EventRow } from './events-query.js'
import { DECISIONS, OWNER_WAITS, readCurrent, staleLine } from './bus-readings.js'
import { bodyAdmittedAfter, waitClosedBefore } from './card-readings.js'
import { byId, EITHER_JOURNAL, events, latestOfCardWhere } from './events-query.js'
import { CARD_ADMITTED, CARD_STOPPED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, POLICY_DENIED, QUESTION_OWNER, SHARD_DECIDED, WINDOW_REQUEST } from './events.js'

export { RESTART_MISSED } from './events.js'
export const OWNER = 'owner'
export const ANSWER_SOURCE = 'answer'
export const PREFIX = '[bus:inbox] '
export const CARD_BLOCKS = 'card_blocks'
export const OWNER_QUESTION_ANSWERED = 'owner_question_answered'

export interface InboxPrReadings {
  mergedAt: (db: DatabaseSync, cardId: number) => readonly number[]
}

interface Stop {
  id: number
  card_id: number | null
  pr: number | null
  data: Record<string, unknown> | null
}

const A_NUMBER_LITERAL = /^\s*[+-]?\d+(?:\.\d+)?\s*$/

function sameNumber(value: unknown, wanted: number): boolean {
  if (typeof value === 'number')
    return value === wanted
  return typeof value === 'string' && A_NUMBER_LITERAL.test(value) && Number(value) === wanted
}

function sameOrBothAbsent(value: unknown, wanted: number | null): boolean {
  return wanted === null ? value === undefined || value === null : sameNumber(value, wanted)
}

function blocksOfCardLine(db: DatabaseSync, card: unknown): unknown[] | null {
  if (typeof card !== 'string')
    return null
  const blocks = (db.prepare(`SELECT ${CARD_BLOCKS}(?) AS blocks`).get(card) as { blocks: string | null }).blocks
  return blocks === null ? null : JSON.parse(blocks) as unknown[]
}

function blocksIn(db: DatabaseSync, event: EventRow): unknown[] | null {
  const card = event.data?.card
  const written = typeof card === 'object' && card !== null ? (card as Record<string, unknown>).blocks : undefined
  if (written !== undefined && written !== null)
    return Array.isArray(written) ? written : [written]
  return blocksOfCardLine(db, card)
}

function latestBlocksOf(db: DatabaseSync, cardId: number): unknown[] {
  for (const line of events(db, { card: cardId, legacy: EITHER_JOURNAL, newestFirst: true })) {
    const blocks = blocksIn(db, line)
    if (blocks !== null)
      return blocks
  }
  return []
}

function blockersOf(db: DatabaseSync, cardId: number): number[] {
  const named = new Set(events(db, { mentions: `#${cardId}`, legacy: EITHER_JOURNAL }).flatMap(event => event.card_id === null ? [] : [event.card_id]))
  return [...named].filter(blocker => latestBlocksOf(db, blocker).some(blocked => sameNumber(blocked, cardId)))
}

function everyBlockerMergedAfter(db: DatabaseSync, stop: Stop, prs: InboxPrReadings): boolean {
  if (stop.card_id === null)
    return false
  const merged = blockersOf(db, stop.card_id).map(blocker => prs.mergedAt(db, blocker))
  return merged.some(at => at.some(eventId => eventId > stop.id)) && merged.every(at => at.length > 0)
}

const TOUCHES_PREFIX_SUFFIX = '/**'
const PREFIX_KEPT = TOUCHES_PREFIX_SUFFIX.length - 1

function withinTouches(touched: unknown, wanted: string): boolean {
  if (touched === wanted)
    return true
  if (typeof touched !== 'string' || !touched.endsWith(TOUCHES_PREFIX_SUFFIX))
    return false
  const kept = touched.length - PREFIX_KEPT
  return wanted.slice(0, kept) === touched.slice(0, kept)
}

const SPACES_AROUND = /^ +| +$/g

function createdAs(created: unknown, wanted: string): boolean {
  const trimmed = String(created).replace(SPACES_AROUND, '')
  return trimmed === wanted || trimmed.slice(0, wanted.length + 2) === `${wanted} (`
}

function widenAsked(stop: Stop): unknown[] | null {
  const widen = stop.data?.widen
  return Array.isArray(widen) && widen.length > 0 ? widen : null
}

function widenedByAnAmend(db: DatabaseSync, stop: Stop): boolean {
  const widen = widenAsked(stop)
  if (stop.card_id === null || widen === null)
    return false
  const amended = bodyAdmittedAfter(db, stop.card_id, stop.id)
  return amended !== null && widen.every(wanted => amended.touches.some(touched => withinTouches(touched, String(wanted))) || amended.creates.some(created => createdAs(created, String(wanted))))
}

function stopOf(event: EventRow): Stop {
  return { id: event.id, card_id: event.card_id, pr: event.pr, data: event.data }
}

function latestOwnerStopBetween(db: DatabaseSync, cardId: number, after: number, before: number): Stop | null {
  const stop = events(db, { types: [CARD_STOPPED], card: cardId, since: after, before, newestFirst: true }).find(each => each.data?.reason === QUESTION_OWNER)
  return stop === undefined ? null : stopOf(stop)
}

export function amendLeavesTheWidenOfTheWaitUncovered(db: DatabaseSync, cardId: number, waitOpened: number, amend: number): boolean {
  const stop = latestOwnerStopBetween(db, cardId, waitOpened, amend)
  return stop !== null && widenAsked(stop) !== null && !widenedByAnAmend(db, stop)
}

function waitClosedAt(db: DatabaseSync, wait: string, eventId: number): boolean {
  return waitClosedBefore(db, wait, eventId + 1) && !waitClosedBefore(db, wait, eventId)
}

function waitClosedByAnAmend(db: DatabaseSync, stop: Stop, wait: unknown): boolean {
  if (stop.card_id === null || wait === null || widenAsked(stop) !== null)
    return false
  return events(db, { types: [CARD_ADMITTED], card: stop.card_id, since: stop.id }).some(amend => waitClosedAt(db, String(wait), amend.id))
}

function liftedByTheWindow(db: DatabaseSync, stop: Stop): boolean {
  return stop.card_id !== null && events(db, { types: [SHARD_DECIDED], card: stop.card_id, since: stop.id }).some(lifted => sameNumber(lifted.data?.stop, stop.id))
}

function opensADecisionWaitFor(opened: EventRow, stop: Stop): boolean {
  const wait = opened.data
  return wait !== null && wait.need === 'decision' && wait.command !== undefined && wait.command !== null
    && (wait.request === undefined || wait.request === null) && sameOrBothAbsent(wait.pr, stop.pr)
}

function waitOpenedForTheStop(db: DatabaseSync, stop: Stop): unknown {
  if (stop.card_id === null)
    return null
  for (const opened of events(db, { types: [OWNER_WAIT_OPENED], card: stop.card_id })) {
    if (!opensADecisionWaitFor(opened, stop))
      continue
    const id = opened.data!.id ?? null
    if (id === null || !waitClosedBefore(db, String(id), stop.id))
      return id
  }
  return null
}

function requestFromTheAnswer(db: DatabaseSync, request: unknown): boolean {
  const id = typeof request === 'number' ? request : typeof request === 'string' && A_NUMBER_LITERAL.test(request) ? Number(request) : null
  if (id === null)
    return false
  const asked = byId(db, id)
  return asked !== null && asked.type === WINDOW_REQUEST && asked.data?.from === ANSWER_SOURCE
}

function answeredThroughTheOwnerChannel(db: DatabaseSync, stop: Stop, wait: unknown): boolean {
  if (wait === null)
    return false
  return events(db, { types: [OWNER_WAIT_CLOSED], since: stop.id }).some(closed => closed.data !== null && closed.data.id === wait && requestFromTheAnswer(db, closed.data.request))
}

const NOT_PART_OF_A_NAME = '[^0-9A-Za-z_]'
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

function textNames(text: string, name: string): boolean {
  return new RegExp(`${NOT_PART_OF_A_NAME}${name.replace(REGEXP_SPECIAL, '\\$&')}${NOT_PART_OF_A_NAME}`).test(` ${text} `)
}

function admissionTextBefore(db: DatabaseSync, cardId: number, amend: number): string | null {
  const prior = events(db, { types: [CARD_ADMITTED], card: cardId, before: amend, newestFirst: true }).find(admitted => typeof admitted.data?.text === 'string')
  return prior === undefined ? null : prior.data!.text as string
}

function namedAsTheAnswerByAnAmend(db: DatabaseSync, stop: Stop, wait: unknown): boolean {
  if (stop.card_id === null)
    return false
  const names = [String(stop.id), ...(wait === null ? [] : [String(wait)])]
  return events(db, { types: [CARD_ADMITTED], card: stop.card_id, since: stop.id }).some((amend) => {
    const before = admissionTextBefore(db, stop.card_id!, amend.id)
    const text = String(amend.data?.text ?? '')
    return before !== null && names.some(name => textNames(text, name) && !textNames(before, name))
  })
}

const A_DECISION_NAMING_THE_CARD_AFTER = `SELECT 1 FROM decisions AS answer, json_each(answer.scope) AS named WHERE answer.event_id > ? AND named.value = ? LIMIT 1`

function decidedAfter(db: DatabaseSync, stop: Stop): boolean {
  return stop.card_id !== null && db.prepare(A_DECISION_NAMING_THE_CARD_AFTER).get(stop.id, stop.card_id) !== undefined
}

export function ownerQuestionAnsweredAt(db: DatabaseSync, stopId: number, prs: InboxPrReadings): boolean {
  const event = byId(db, stopId)
  if (event === null)
    return false
  const stop = stopOf(event)
  if (decidedAfter(db, stop) || liftedByTheWindow(db, stop) || widenedByAnAmend(db, stop))
    return true
  const wait = waitOpenedForTheStop(db, stop)
  return answeredThroughTheOwnerChannel(db, stop, wait) || waitClosedByAnAmend(db, stop, wait) || namedAsTheAnswerByAnAmend(db, stop, wait) || everyBlockerMergedAfter(db, stop, prs)
}

export function ownerQuestionAnswered(stop: string): string {
  return `(${OWNER_QUESTION_ANSWERED}(${stop}.id) = 1)`
}

export const OPEN_OWNER_STOP_OF_CARD = latestOfCardWhere('stop', `stop.type = '${CARD_STOPPED}' AND json_extract(stop.payload, '$.reason') = '${QUESTION_OWNER}' AND NOT ${ownerQuestionAnswered('stop')}`)

export interface InboxLine {
  id: number
  type: string
  card_id: number | null
  pr: number | null
  head: string | null
  payload: string
}

const ANSWERED_STOP = `SELECT ${OWNER_QUESTION_ANSWERED}(?) AS answered`

function anOpenOwnerQuestion(db: DatabaseSync, item: EventRow): boolean {
  return item.data?.reason === QUESTION_OWNER && Number((db.prepare(ANSWERED_STOP).get(item.id) as { answered: number }).answered) !== 1
}

function inTheInbox(db: DatabaseSync, item: EventRow): boolean {
  return item.type === POLICY_DENIED ? item.data?.kind === 'authority' : anOpenOwnerQuestion(db, item)
}

export function ownerInbox(db: DatabaseSync): InboxLine[] {
  return events(db, { types: [POLICY_DENIED, CARD_STOPPED] })
    .filter(item => inTheInbox(db, item))
    .map(item => ({ id: item.id, type: item.type, card_id: item.card_id, pr: item.pr, head: item.head, payload: item.payload }))
}

function field(payload: Record<string, unknown>, name: string): string | null {
  return typeof payload[name] === 'string' ? payload[name] : null
}

export function inboxText(line: InboxLine): string {
  const payload = JSON.parse(line.payload) as Record<string, unknown>
  const what = line.type === POLICY_DENIED ? `authority ${field(payload, 'rule') ?? '-'}` : QUESTION_OWNER
  const parts = [
    `${line.type} ${what}`,
    line.card_id === null ? null : `card #${line.card_id}`,
    line.pr === null ? null : `PR #${line.pr}`,
    field(payload, 'command'),
    field(payload, 'detail'),
  ]
  return `${PREFIX}${parts.filter(part => part !== null).join(' · ')}`
}

const STALE_EXIT = 1

export function runInbox(db: DatabaseSync, out: (line: string) => void): number {
  const reading = readCurrent(db, [DECISIONS, OWNER_WAITS], () => ownerInbox(db))
  if (reading.stale !== null) {
    out(`${PREFIX}${staleLine(reading.stale)}`)
    return STALE_EXIT
  }
  const lines = reading.rows
  for (const line of lines)
    out(inboxText(line))
  if (lines.length === 0)
    out(`${PREFIX}the owner inbox is empty`)
  return 0
}
