import type { DatabaseSync } from 'node:sqlite'
import type { LastReduced, OwnerWait } from './bus-readings.js'
import type { EventRow } from './events-query.js'
import { CLOSED_WAIT, OPEN_WAIT, OWNER_WAITS, readLastReduced } from './bus-readings.js'
import { cardIdsInEvents, EITHER_JOURNAL, events, eventsWhere, latest } from './events-query.js'
import { CARD_ANSWERED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, CARD_WAITING, LADDER_RUN, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_CLOSED, QUESTION_AGENT, WITNESS_DOWNGRADE } from './events.js'

export type { BusPanelRow, EventRow } from './events-query.js'
export { busPanelRow, EITHER_JOURNAL, events, lastObjectFieldPerCard, lastPer, lastSlotsPerQueue, latest, newestEventsOfEachCard } from './events-query.js'
export type { TaskRow } from './tasks-query.js'
export { inStates as tasksInStates } from './tasks-query.js'

const OPEN_OWNER_WAITS = `
  SELECT id, need, text, command, card_id AS card, pr, opened_at AS since
  FROM ${OWNER_WAITS}
  WHERE state = '${OPEN_WAIT}'
  ORDER BY CAST(substr(id, 2) AS INTEGER), id
`

const CLOSED_WAIT_IDS = `SELECT id FROM ${OWNER_WAITS} WHERE state = '${CLOSED_WAIT}' ORDER BY id`

function liftedBy(decision: string | null): OwnerWait['lifter'] {
  return decision === null ? 'owner' : 'window'
}

function closedByAnEvent(db: DatabaseSync): Set<unknown> {
  return new Set(events(db, { types: [OWNER_WAIT_CLOSED] }).map(closed => closed.data?.id))
}

function decisionsOfTheOpenings(db: DatabaseSync, ids: readonly string[]): Map<string, string | null> {
  const opened = events(db, { types: [OWNER_WAIT_OPENED], keys: ids.map(id => `${OWNER_WAIT_OPENED}:${id}`), legacy: EITHER_JOURNAL })
  return new Map(opened.map(event => [event.dedupe_key.slice(OWNER_WAIT_OPENED.length + 1), (event.data?.decision ?? null) as string | null]))
}

export function openOwnerWaits(db: DatabaseSync): OwnerWait[] {
  const closed = closedByAnEvent(db)
  const open = (db.prepare(OPEN_OWNER_WAITS).all() as unknown as Omit<OwnerWait, 'lifter' | 'decision'>[]).filter(wait => !closed.has(wait.id))
  const decisions = decisionsOfTheOpenings(db, open.map(wait => wait.id))
  return open.map((wait) => {
    const decision = decisions.get(wait.id) ?? null
    return { ...wait, decision, lifter: liftedBy(decision) }
  })
}

export function lastReducedOwnerWaits(db: DatabaseSync): LastReduced<OwnerWait[]> {
  return readLastReduced(db, [OWNER_WAITS], () => openOwnerWaits(db))
}

export function closedWaitIds(db: DatabaseSync): string[] {
  return (db.prepare(CLOSED_WAIT_IDS).all() as { id: string }[]).map(row => String(row.id))
}

export function closedWaitTextsOf(db: DatabaseSync, cardId: number): string[] {
  const closed = new Set(closedWaitIds(db))
  return events(db, { types: [OWNER_WAIT_OPENED], card: cardId })
    .flatMap(opened => closed.has(String(opened.data?.id)) && typeof opened.data?.text === 'string' ? [opened.data.text] : [])
}

const A_WAIT_CLOSED_BEFORE = `SELECT 1 FROM ${OWNER_WAITS} WHERE id = ? AND state = '${CLOSED_WAIT}' AND event_id < ? LIMIT 1`

export function waitClosedBefore(db: DatabaseSync, id: string, eventId: number): boolean {
  return db.prepare(A_WAIT_CLOSED_BEFORE).get(id, eventId) !== undefined
}

export interface AdmittedBody {
  admission_event_id: number
  touches: unknown[]
  creates: unknown[]
}

const CARD_BODIES = 'card_bodies'

const BODY_COLUMNS = `SELECT admission_event_id, touches, creates FROM ${CARD_BODIES} WHERE card_id = ?`
const BODY_ADMITTED_AFTER = `${BODY_COLUMNS} AND admission_event_id > ?`

interface StoredBody {
  admission_event_id: number
  touches: unknown
  creates: unknown
}

function listOf(stored: unknown): unknown[] {
  if (typeof stored !== 'string')
    return []
  const parsed = JSON.parse(stored) as unknown
  return Array.isArray(parsed) ? parsed : [parsed]
}

function bodyOf(row: StoredBody | undefined): AdmittedBody | null {
  return row === undefined ? null : { admission_event_id: Number(row.admission_event_id), touches: listOf(row.touches), creates: listOf(row.creates) }
}

export function bodyAdmittedAfter(db: DatabaseSync, cardId: number, eventId: number): AdmittedBody | null {
  return bodyOf(db.prepare(BODY_ADMITTED_AFTER).get(cardId, eventId) as StoredBody | undefined)
}

export function admittedBodyOf(db: DatabaseSync, cardId: number): AdmittedBody | null {
  return bodyOf(db.prepare(BODY_COLUMNS).get(cardId) as StoredBody | undefined)
}

const CARD_STATES_AMONG = `SELECT card_id, state FROM cards WHERE card_id IN (SELECT value FROM json_each(?))`

export function cardStatesAmong(db: DatabaseSync, cardIds: readonly number[]): Map<number, string | null> {
  const rows = db.prepare(CARD_STATES_AMONG).all(JSON.stringify(cardIds)) as { card_id: number, state: string | null }[]
  return new Map(rows.map(row => [Number(row.card_id), row.state === null ? null : String(row.state)]))
}

export interface CardOfStop {
  state: string | null
  pr: number | null
}

const CARDS_AMONG = `SELECT card_id, state, pr FROM cards WHERE card_id IN (SELECT value FROM json_each(?))`

export function cardsAmong(db: DatabaseSync, cardIds: readonly number[]): Map<number, CardOfStop> {
  const rows = db.prepare(CARDS_AMONG).all(JSON.stringify(cardIds)) as { card_id: number, state: string | null, pr: number | null }[]
  return new Map(rows.map(row => [Number(row.card_id), { state: row.state === null ? null : String(row.state), pr: row.pr === null ? null : Number(row.pr) }]))
}

const ENTERED_STATE_AMONG = `SELECT card_id, event_id FROM cards WHERE state = ? AND card_id IN (SELECT value FROM json_each(?))`

export function stateEventsAmong(db: DatabaseSync, state: string, cardIds: readonly number[]): Map<number, number> {
  const rows = db.prepare(ENTERED_STATE_AMONG).all(state, JSON.stringify(cardIds)) as { card_id: number, event_id: number }[]
  return new Map(rows.map(row => [Number(row.card_id), Number(row.event_id)]))
}

const CARD_LINES_OF_HELD_BODIES = `SELECT cards.card_id, body.card_line FROM cards JOIN ${CARD_BODIES} AS body ON body.card_id = cards.card_id ORDER BY cards.card_id`

function cardLinesOfHeldBodies(db: DatabaseSync): Map<number, string | null> {
  const rows = db.prepare(CARD_LINES_OF_HELD_BODIES).all() as { card_id: number, card_line: string | null }[]
  return new Map(rows.map(row => [Number(row.card_id), row.card_line === null ? null : String(row.card_line)]))
}

export interface CardEnd {
  card_id: number
  card_line: string | null
  ended: string
  end_type: string
  end_payload: string
}

export interface CardTurn {
  card_id: number
  type: string
  ts: string
  payload: string
}

const MERGED_FLAGS: readonly unknown[] = [true, 1]

function lastWhere(rows: readonly EventRow[], matches: (row: EventRow) => boolean): EventRow | undefined {
  let found: EventRow | undefined
  for (const row of rows) {
    if (matches(row))
      found = row
  }
  return found
}

export type PrsOfCard = (card: number) => ReadonlySet<number>

export function cardEnds(db: DatabaseSync, prsOf: PrsOfCard): CardEnd[] {
  const merges = events(db, { types: [PR_CLOSED] }).filter(row => MERGED_FLAGS.includes(row.data?.merged))
  const closes = events(db, { types: [CARD_CLOSED], withCard: true, legacy: EITHER_JOURNAL })
  return [...cardLinesOfHeldBodies(db)].flatMap(([card, line]) => {
    const prs = prsOf(card)
    const end = lastWhere(merges, row => row.card_id === card || (row.pr !== null && prs.has(row.pr))) ?? lastWhere(closes, row => row.card_id === card)
    return end === undefined || end.ts === null ? [] : [{ card_id: card, card_line: line, ended: end.ts, end_type: end.type, end_payload: end.payload }]
  })
}

export function cardTurnsOf(db: DatabaseSync, types: readonly string[]): CardTurn[] {
  return events(db, { types, withCard: true }).flatMap(row =>
    row.card_id === null || row.ts === null ? [] : [{ card_id: row.card_id, type: row.type, ts: row.ts, payload: row.payload }])
}

export function ladderRunPayloads(db: DatabaseSync): string[] {
  return events(db, { types: [LADDER_RUN], legacy: EITHER_JOURNAL }).map(row => row.payload)
}

export function legacyLinePayloads(db: DatabaseSync): string[] {
  return events(db, { legacy: true }).map(row => row.payload)
}

const LINKED_PR = 'SELECT pr FROM cards WHERE card_id = ?'
const LINKED_PRS = 'SELECT card_id, pr FROM cards WHERE pr IS NOT NULL'

export function linkedPrs(db: DatabaseSync): Map<number, number> {
  const rows = db.prepare(LINKED_PRS).all() as { card_id: number, pr: number }[]
  return new Map(rows.map(row => [Number(row.card_id), Number(row.pr)]))
}

const CARD_OF_PR = 'SELECT card_id FROM cards WHERE pr = ?'

export function linkedPrOf(db: DatabaseSync, cardId: number): number | null {
  const pr = (db.prepare(LINKED_PR).get(cardId) as { pr: number | null } | undefined)?.pr ?? null
  return pr === null ? null : Number(pr)
}

export function cardOfPr(db: DatabaseSync, pr: number): number | null {
  const cardId = (db.prepare(CARD_OF_PR).get(pr) as { card_id: number } | undefined)?.card_id
  return cardId === undefined ? null : Number(cardId)
}

export interface CardDependent {
  id: number
  text: string
}

const DEPENDENTS_IN_STATE = `
  SELECT body.card_id AS id, body.text FROM ${CARD_BODIES} AS body JOIN cards ON cards.card_id = body.card_id
  WHERE cards.state = ? AND EXISTS (SELECT 1 FROM json_each(body.depends) WHERE value = ?)
  ORDER BY body.card_id
`

export function dependentsInStateOf(db: DatabaseSync, cardId: number, state: string): CardDependent[] {
  return db.prepare(DEPENDENTS_IN_STATE).all(state, cardId) as unknown as CardDependent[]
}

export interface CardWithItsLine {
  id: number
  state: string | null
  pr: number | null
  line: string | null
  body: boolean
  event_id: number
}

const CARDS_WITH_THEIR_LINES = `
  SELECT cards.card_id AS id, cards.state, cards.pr, body.card_line AS line, body.card_id IS NOT NULL AS body, cards.event_id
  FROM cards LEFT JOIN ${CARD_BODIES} AS body ON body.card_id = cards.card_id
  ORDER BY cards.card_id
`

export function cardsWithTheirLines(db: DatabaseSync): CardWithItsLine[] {
  const rows = db.prepare(CARDS_WITH_THEIR_LINES).all() as { id: number, state: string | null, pr: number | null, line: string | null, body: number, event_id: number }[]
  return rows.map(row => ({ id: Number(row.id), state: row.state === null ? null : String(row.state), pr: row.pr === null ? null : Number(row.pr), line: row.line === null ? null : String(row.line), body: Boolean(row.body), event_id: Number(row.event_id) }))
}

export function stateEventsOfCardsIn(db: DatabaseSync, states: readonly string[]): Map<number, number> {
  if (states.length === 0)
    return new Map()
  const rows = db.prepare(`SELECT card_id, event_id FROM cards WHERE state IN (${states.map(() => '?').join(', ')})`).all(...states) as { card_id: number, event_id: number }[]
  return new Map(rows.map(row => [Number(row.card_id), Number(row.event_id)]))
}

const CARDS_WITH_A_STATE = `SELECT card_id, state FROM cards WHERE state IS NOT NULL`

export function cardsWithAState(db: DatabaseSync): Map<number, string> {
  const rows = db.prepare(CARDS_WITH_A_STATE).all() as { card_id: number, state: string }[]
  return new Map(rows.map(row => [Number(row.card_id), String(row.state)]))
}

export function heldCardStates(db: DatabaseSync): Map<number, string | null> {
  const held = new Map<number, string | null>(cardsWithAState(db))
  for (const card of cardIdsInEvents(db)) {
    if (!held.has(card))
      held.set(card, null)
  }
  return held
}

const CARD_TURNS = [CARD_STOPPED, CARD_ANSWERED, CARD_STARTED]

export interface StandingStop {
  id: number
  payload: Record<string, unknown>
}

export function standingStopOf(db: DatabaseSync, cardId: number): StandingStop | null {
  const turn = latest(db, { card: cardId, types: CARD_TURNS })
  return turn === null || turn.type !== CARD_STOPPED ? null : { id: turn.id, payload: turn.data ?? {} }
}

const WAITS_AMONG = `SELECT id FROM ${OWNER_WAITS} WHERE id IN (SELECT value FROM json_each(?))`

export function waitIdsAmong(db: DatabaseSync, ids: readonly string[]): string[] {
  return (db.prepare(WAITS_AMONG).all(JSON.stringify(ids)) as { id: string }[]).map(wait => String(wait.id))
}

const WAIT_STATES_AMONG = `SELECT id, state FROM ${OWNER_WAITS} WHERE id IN (SELECT value FROM json_each(?))`

export function waitStatesAmong(db: DatabaseSync, ids: readonly string[]): Map<string, string> {
  const rows = db.prepare(WAIT_STATES_AMONG).all(JSON.stringify(ids)) as { id: string, state: string }[]
  return new Map(rows.map(wait => [String(wait.id), String(wait.state)]))
}

const OPEN_WAITS_OF_CARDS = `SELECT card_id, event_id FROM ${OWNER_WAITS} WHERE state = '${OPEN_WAIT}' AND card_id IS NOT NULL ORDER BY event_id`

export function openWaitEventsByCard(db: DatabaseSync): Map<number, number[]> {
  const byCard = new Map<number, number[]>()
  for (const row of db.prepare(OPEN_WAITS_OF_CARDS).all() as { card_id: number, event_id: number }[]) {
    const card = Number(row.card_id)
    byCard.set(card, [...byCard.get(card) ?? [], Number(row.event_id)])
  }
  return byCard
}

const CLOSED_WAITS_OF_THE_CARD = `SELECT id, event_id FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${CLOSED_WAIT}'`

export interface ClosedWait {
  id: string
  event_id: number
  type: string
}

export function closedWaitsOfCard(db: DatabaseSync, cardId: number): ClosedWait[] {
  const closed = (db.prepare(CLOSED_WAITS_OF_THE_CARD).all(cardId) as { id: string, event_id: number }[]).map(wait => ({ id: String(wait.id), event_id: Number(wait.event_id) }))
  const types = new Map(events(db, { ids: closed.map(wait => wait.event_id), legacy: EITHER_JOURNAL }).map(event => [event.id, event.type]))
  return closed.flatMap((wait) => {
    const type = types.get(wait.event_id)
    return type === undefined ? [] : [{ ...wait, type }]
  })
}

const CLOSED_WAIT_ANSWERS_OF_THE_CARD = `SELECT id, answer FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${CLOSED_WAIT}' ORDER BY event_id`

export interface ClosedWaitAnswer {
  id: string
  answer: string | null
}

export function closedWaitAnswersOfCard(db: DatabaseSync, cardId: number): ClosedWaitAnswer[] {
  return (db.prepare(CLOSED_WAIT_ANSWERS_OF_THE_CARD).all(cardId) as { id: string, answer: string | null }[]).map(wait => ({ id: String(wait.id), answer: wait.answer === null ? null : String(wait.answer) }))
}

const OPEN_WAIT_PRS_OF_A_NEED = `SELECT DISTINCT pr FROM ${OWNER_WAITS} WHERE need = ? AND state = '${OPEN_WAIT}' AND pr IS NOT NULL`

export function openWaitPrsOf(db: DatabaseSync, need: string): Set<number> {
  return new Set((db.prepare(OPEN_WAIT_PRS_OF_A_NEED).all(need) as { pr: number }[]).map(row => Number(row.pr)))
}

export function openDecisionWaitsOf(card: string): string {
  return `SELECT id, text FROM ${OWNER_WAITS} WHERE need = 'decision' AND state = '${OPEN_WAIT}' AND card_id = ${card}`
}

const OPEN_DECISION_WAITS_OF_THE_CARD = `${openDecisionWaitsOf('?')} ORDER BY opened_at, id`

export interface OpenDecisionWait {
  id: string
  text: string
}

export function openDecisionWaitsOfCard(db: DatabaseSync, cardId: number): OpenDecisionWait[] {
  return db.prepare(OPEN_DECISION_WAITS_OF_THE_CARD).all(cardId) as unknown as OpenDecisionWait[]
}

const OPEN_WAIT_EVENTS_OF_THE_CARD = `SELECT event_id FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${OPEN_WAIT}'`

export function downgradeWaitOpenOn(db: DatabaseSync, cardId: number): boolean {
  const asked = (db.prepare(OPEN_WAIT_EVENTS_OF_THE_CARD).all(cardId) as { event_id: number }[]).map(row => Number(row.event_id))
  return events(db, { ids: asked, types: [CARD_WAITING], legacy: EITHER_JOURNAL }).some(event => event.data?.reason === WITNESS_DOWNGRADE)
}

export function aDowngradeWaitOpenOn(card: string): string {
  const asked = eventsWhere('asked', '1', `asked.id = wait.event_id AND asked.type = '${CARD_WAITING}' AND json_extract(asked.payload, '$.reason') = '${WITNESS_DOWNGRADE}'`)
  return `EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS wait WHERE wait.card_id = ${card} AND wait.state = '${OPEN_WAIT}' AND EXISTS (${asked}))`
}

export function cardPriorityOf(card: string): string {
  return `(SELECT body.priority FROM ${CARD_BODIES} AS body WHERE body.card_id = ${card})`
}

export function cardBodiesWhere(columns: string, condition: string): string {
  return `
  SELECT ${columns} FROM ${CARD_BODIES} AS body
  WHERE ${condition}
  ORDER BY body.card_id
`
}

export function aCardInStates(card: string, states: readonly string[]): string {
  return `EXISTS (SELECT 1 FROM cards WHERE cards.card_id = ${card} AND cards.state IN (${states.map(state => `'${state}'`).join(', ')}))`
}

export function notACardOf(who: string): (card: string) => string {
  return card => `NOT EXISTS (SELECT 1 FROM ${CARD_BODIES} AS body WHERE body.card_id = ${card} AND body.who = '${who}')`
}

export function latestQuestionStopsWithTheirCard(latestTurnOf: (card: string) => string): string {
  const stops = eventsWhere('stop', '*', `stop.type = '${CARD_STOPPED}' AND stop.legacy = 0 AND stop.card_id IS NOT NULL
    AND json_extract(stop.payload, '$.reason') = '${QUESTION_AGENT}' AND stop.id = ${latestTurnOf('stop.card_id')}`)
  return `(${stops}) AS stop LEFT JOIN cards ON cards.card_id = stop.card_id`
}
