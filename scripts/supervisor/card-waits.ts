import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from '../core/stored.js'
import { latestOfEachType } from '../core/bus-readings.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { foldCardBody } from '../core/card-bodies.js'
import { appendEvent, CLOSED_WAIT, isOwnerWaitNeed, OPEN_WAIT, OWNER_WAIT_NEEDS, WAIT_ID } from '../core/db.js'
import { EITHER_JOURNAL, events } from '../core/events-query.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_MOVED, CARD_WAITING, DECISION_RECORDED, DECISIONS_CUT_OVER, DECISIONS_IMPORTED, MERGE_DONE, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, WITNESS_DOWNGRADE } from '../core/events.js'
import { prOf } from '../core/identifiers.js'
import { ADMIT_COMMAND } from '../core/owner-commands.js'
import { payloadOf, reject } from '../core/stored.js'
import { cardIdOf } from '../ports/identifier-shapes.js'

export interface CardWaitParts {
  archiveSpentDecisions: (db: DatabaseSync) => void
  prRow: (db: DatabaseSync, pr: number) => { card_id: number | null } | undefined
  prsOfCard: (db: DatabaseSync, cardId: number) => readonly number[]
  cardFolds: Readonly<Record<string, Fold>>
  amendLeavesTheWidenOfTheWaitUncovered: (db: DatabaseSync, cardId: number, waitOpened: number, amend: number) => boolean
}

export const DOWNGRADE_WAIT_PREFIX = 'W'
const DOWNGRADE_WAIT_ID = new RegExp(`^${DOWNGRADE_WAIT_PREFIX}\\d+$`)

export interface OwnerWaitFacts {
  id: string
  need: string
  card: number | null
  pr: number | null
}

export interface DecisionAnswer {
  answer: string
  scope: string
  commands: readonly string[]
  named: readonly string[]
}

export interface OwnerWaitParts {
  commandOf: (wait: OwnerWaitFacts, asked: string | null) => string
  decisionFolds: Readonly<Record<string, Fold>>
  answersOfTheDecisions: (db: DatabaseSync, eventId: number) => readonly DecisionAnswer[]
  closeWaitsOfAnEndedCard: (db: DatabaseSync, cardId: number | null, eventId: number) => void
}

export function filled(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function optional<T>(payload: Record<string, unknown>, field: string, read: (value: unknown) => T | null): T | null {
  const value = payload[field]
  return value === undefined || value === null ? null : read(value) ?? reject(`${field} is not valid: ${JSON.stringify(value)}`)
}

function busNamesTheAction(need: string, command: string | null, pr: number | null): boolean {
  if (need === 'merge')
    return pr !== null
  return command !== null || (need === 'decision' && pr !== null)
}

function foldOwnerWaitOpened(db: DatabaseSync, event: StoredEvent, parts: OwnerWaitParts): void {
  const payload = payloadOf(event)
  const id = typeof payload.id === 'string' && WAIT_ID.test(payload.id) ? payload.id : reject('id is not Q<N>')
  const need = isOwnerWaitNeed(payload.need) ? payload.need : reject(`need is not one of ${OWNER_WAIT_NEEDS.join(' | ')}`)
  const text = filled(payload.text) ?? reject('text is empty')
  const command = optional(payload, 'command', filled)
  const card = optional(payload, 'card', prOf)
  const pr = optional(payload, 'pr', prOf)
  if (need === 'command' && command === null)
    reject('a command wait names no command')
  if (optional(payload, 'request', prOf) === null && !busNamesTheAction(need, command, pr))
    reject(`the bus names no owner action for this ${need}: a finding for the backlog, not an owner wait`)
  if (db.prepare('SELECT 1 FROM owner_waits WHERE id = ?').get(id) !== undefined)
    reject(`${id} is already opened`)
  db.prepare(`INSERT INTO owner_waits (id, need, text, command, card_id, pr, state, answer, opened_at, event_id) VALUES (?, ?, ?, ?, ?, ?, '${OPEN_WAIT}', NULL, ?, ?)`)
    .run(id, need, text, parts.commandOf({ id, need, card, pr }, command), card, pr, event.ts, event.id)
}

function foldOwnerWaitClosed(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const id = typeof payload.id === 'string' && (WAIT_ID.test(payload.id) || DOWNGRADE_WAIT_ID.test(payload.id)) ? payload.id : reject(`id is not Q<N> or ${DOWNGRADE_WAIT_PREFIX}<N>`)
  const answer = filled(payload.answer) ?? reject('answer is empty')
  const wait = db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(id) as { state: string } | undefined
  if (wait === undefined)
    reject(`${id} was never opened`)
  if (wait.state !== OPEN_WAIT)
    reject(`${id} is already closed`)
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE id = ?`).run(answer, event.id, id)
}

export function downgradeWaitId(eventId: number): string {
  return `${DOWNGRADE_WAIT_PREFIX}${eventId}`
}

function foldWitnessDowngradeWait(db: DatabaseSync, event: StoredEvent, parts: OwnerWaitParts): void {
  const payload = payloadOf(event)
  if (payload.reason !== WITNESS_DOWNGRADE)
    return
  const cardId = event.card_id ?? reject('a witness downgrade names no card')
  const actions = Array.isArray(payload.actions) ? payload.actions.map(filled) : []
  if (actions.length === 0 || actions.includes(null))
    reject('a witness downgrade names no action for the owner')
  const id = downgradeWaitId(event.id)
  db.prepare(`INSERT INTO owner_waits (id, need, text, command, card_id, pr, state, answer, opened_at, event_id) VALUES (?, 'decision', ?, ?, ?, NULL, '${OPEN_WAIT}', NULL, ?, ?)`)
    .run(id, actions.join('; '), parts.commandOf({ id, need: 'decision', card: cardId, pr: null }, null), cardId, event.ts, event.id)
  parts.closeWaitsOfAnEndedCard(db, cardId, event.id)
}

function waitsOpenedForTheCommands(db: DatabaseSync, commands: readonly string[]): number[] {
  if (commands.length === 0)
    return []
  return events(db, { types: [OWNER_WAIT_OPENED], legacy: EITHER_JOURNAL }).filter(opened => typeof opened.data?.command === 'string' && commands.includes(opened.data.command)).map(opened => opened.id)
}

function closeWaitsTheDecisionsAnswer(db: DatabaseSync, event: StoredEvent, parts: OwnerWaitParts): void {
  for (const decision of parts.answersOfTheDecisions(db, event.id)) {
    const named = JSON.stringify(decision.named)
    db.prepare(`
      UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ?
      WHERE state = '${OPEN_WAIT}' AND (event_id IN (SELECT value FROM json_each(?)) OR (need IN ('decision', 'command') AND card_id IN (SELECT value FROM json_each(?)) AND (json_array_length(?) = 0 OR id IN (SELECT value FROM json_each(?)))))
    `).run(decision.answer, event.id, JSON.stringify(waitsOpenedForTheCommands(db, decision.commands)), decision.scope, named, named)
  }
}

function decisionsCutOverOf(db: DatabaseSync): number | null {
  return latestOfEachType(db, [DECISIONS_CUT_OVER])[0]?.latest ?? null
}

function foldDecisionClosingWaits(db: DatabaseSync, event: StoredEvent, parts: OwnerWaitParts): void {
  parts.decisionFolds[event.type]!(db, event)
  const cutOver = decisionsCutOverOf(db)
  if (cutOver !== null && event.id < cutOver)
    closeWaitsTheDecisionsAnswer(db, event, parts)
}

export function ownerWaitFolds(parts: OwnerWaitParts): Record<string, Fold> {
  const decisionClosingWaits: Fold = (db, event) => foldDecisionClosingWaits(db, event, parts)
  return {
    [OWNER_WAIT_OPENED]: (db, event) => foldOwnerWaitOpened(db, event, parts),
    [OWNER_WAIT_CLOSED]: foldOwnerWaitClosed,
    [CARD_WAITING]: (db, event) => foldWitnessDowngradeWait(db, event, parts),
    [DECISION_RECORDED]: decisionClosingWaits,
    [DECISIONS_IMPORTED]: decisionClosingWaits,
  }
}

const ENDED_CARD_STATES: ReadonlySet<string | null> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])

function endedCardAnswer(cardId: number, state: string | null): string {
  return `card #${cardId} ${state}`
}

export function closeWaitsOfAnEndedCard(db: DatabaseSync, cardId: number | null, eventId: number): void {
  if (cardId === null)
    return
  const state = (db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined)?.state ?? null
  if (!ENDED_CARD_STATES.has(state))
    return
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND card_id = ?`)
    .run(endedCardAnswer(cardId, state), eventId, cardId)
}

const OPEN_WAITS_OF_ENDED_CARDS = `
  SELECT wait.id, wait.card_id, card.state FROM owner_waits AS wait JOIN cards AS card ON card.card_id = wait.card_id
  WHERE wait.state = '${OPEN_WAIT}' AND card.state IN (SELECT value FROM json_each(?))
  ORDER BY wait.id
`

export function closeWaitsOfEndedCards(db: DatabaseSync, ts: string): string[] {
  const waits = db.prepare(OPEN_WAITS_OF_ENDED_CARDS).all(JSON.stringify([...ENDED_CARD_STATES])) as { id: string, card_id: number, state: string }[]
  for (const wait of waits)
    appendEvent(db, { ts, type: OWNER_WAIT_CLOSED, actor: 'reducer', cardId: wait.card_id, pr: null, head: null, dedupeKey: `${OWNER_WAIT_CLOSED}:${wait.id}:card-${wait.state}`, payload: { id: wait.id, answer: endedCardAnswer(wait.card_id, wait.state) }, legacy: false })
  return waits.map(wait => wait.id)
}

function foldEndingTheWaitsOfAnEndedCard(db: DatabaseSync, event: StoredEvent, parts: CardWaitParts): void {
  parts.cardFolds[event.type]!(db, event)
  closeWaitsOfAnEndedCard(db, event.card_id, event.id)
  parts.archiveSpentDecisions(db)
}

function checkTheChildrenADropNames(event: StoredEvent): void {
  const { children, reason } = payloadOf(event)
  if (children === undefined)
    return
  if (!Array.isArray(children) || children.length === 0 || children.some(child => typeof child !== 'number' || cardIdOf(child) === null || child === event.card_id))
    reject('children is not a list of card numbers other than the dropped card')
  if (filled(reason) === null)
    reject('a drop naming children names no reason')
}

function closeWaitsOnThePrsOfADroppedCard(db: DatabaseSync, event: StoredEvent, parts: CardWaitParts): void {
  if (event.card_id === null)
    return
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND pr IN (SELECT value FROM json_each(?))
    AND EXISTS (SELECT 1 FROM cards WHERE card_id = ? AND state = '${DROPPED_CARD}')`)
    .run(endedCardAnswer(event.card_id, DROPPED_CARD), event.id, JSON.stringify(parts.prsOfCard(db, event.card_id)), event.card_id)
}

function foldDropNamingItsChildren(db: DatabaseSync, event: StoredEvent, parts: CardWaitParts): void {
  checkTheChildrenADropNames(event)
  parts.cardFolds[event.type]!(db, event)
  closeWaitsOfAnEndedCard(db, event.card_id, event.id)
  closeWaitsOnThePrsOfADroppedCard(db, event, parts)
  parts.archiveSpentDecisions(db)
}

function closeDowngradeWaitsTheAdmissionAnswers(db: DatabaseSync, event: StoredEvent): void {
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND card_id = ? AND id LIKE '${DOWNGRADE_WAIT_PREFIX}%' AND event_id < ?`)
    .run(`card #${event.card_id} admitted`, event.id, event.card_id, event.id)
}

const AMEND_COMMAND = `${ADMIT_COMMAND} `

function closeAmendWaitsTheAdmissionAnswers(db: DatabaseSync, event: StoredEvent): void {
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND card_id = ? AND need = 'command' AND substr(command, 1, ?) = ? AND event_id < ?`)
    .run(`card #${event.card_id} amended`, event.id, event.card_id, AMEND_COMMAND.length, AMEND_COMMAND, event.id)
}

const AMEND_ADMISSION = 'amend'

const SINCE_THE_FIRST_EVENT = 0

function closeDecisionWaitsTheAmendAnswers(db: DatabaseSync, event: StoredEvent, parts: CardWaitParts): void {
  const cardId = event.card_id
  if (payloadOf(event).source !== AMEND_ADMISSION || cardId === null)
    return
  if (parts.amendLeavesTheWidenOfTheWaitUncovered(db, cardId, SINCE_THE_FIRST_EVENT, event.id))
    return
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND card_id = ? AND need = 'decision' AND event_id < ?`)
    .run(`card #${cardId} amended`, event.id, cardId, event.id)
}

function foldAdmittedWithBody(db: DatabaseSync, event: StoredEvent, parts: CardWaitParts): void {
  parts.cardFolds[CARD_ADMITTED]!(db, event)
  foldCardBody(db, event)
  closeDowngradeWaitsTheAdmissionAnswers(db, event)
  closeAmendWaitsTheAdmissionAnswers(db, event)
  closeDecisionWaitsTheAmendAnswers(db, event, parts)
}

export function closingTheWaitsOfAClosedPr(parts: CardWaitParts): Fold {
  return (db, event) => {
    const pr = event.pr ?? reject(`${event.type} needs a pr`)
    const merged = payloadOf(event).merged === true
    db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND need = 'merge' AND pr = ?`)
      .run(`PR #${pr} ${merged ? 'merged' : 'closed'}`, event.id, pr)
    closeWaitsOfAnEndedCard(db, parts.prRow(db, pr)?.card_id ?? null, event.id)
    parts.archiveSpentDecisions(db)
  }
}

export function cardWaitFolds(parts: CardWaitParts): Record<string, Fold> {
  const ending: Fold = (db, event) => foldEndingTheWaitsOfAnEndedCard(db, event, parts)
  return {
    [MERGE_DONE]: ending,
    [CARD_CLOSED]: ending,
    [CARD_MOVED]: ending,
    [CARD_DROPPED]: (db, event) => foldDropNamingItsChildren(db, event, parts),
    [CARD_ADMITTED]: (db, event) => foldAdmittedWithBody(db, event, parts),
  }
}
