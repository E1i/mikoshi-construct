import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from '../core/stored.js'
import { CARD_FOLDS, CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { foldCardBody } from '../core/card-bodies.js'
import { appendEvent, CLOSED_WAIT, OPEN_WAIT } from '../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_MOVED, MERGE_DONE, OWNER_WAIT_CLOSED } from '../core/events.js'
import { cardIdOf } from '../core/identifiers.js'
import { ADMIT_COMMAND } from '../core/owner-commands.js'
import { DOWNGRADE_WAIT_PREFIX, filled } from '../core/reducer.js'
import { payloadOf, reject } from '../core/stored.js'

export interface CardWaitParts {
  archiveSpentDecisions: (db: DatabaseSync) => void
  prRow: (db: DatabaseSync, pr: number) => { card_id: number | null } | undefined
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
  CARD_FOLDS[event.type]!(db, event)
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

function foldDropNamingItsChildren(db: DatabaseSync, event: StoredEvent, parts: CardWaitParts): void {
  checkTheChildrenADropNames(event)
  foldEndingTheWaitsOfAnEndedCard(db, event, parts)
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

function closeDecisionWaitsTheAmendAnswers(db: DatabaseSync, event: StoredEvent): void {
  if (payloadOf(event).source !== AMEND_ADMISSION)
    return
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND card_id = ? AND need = 'decision' AND event_id < ?`)
    .run(`card #${event.card_id} amended`, event.id, event.card_id, event.id)
}

function foldAdmittedWithBody(db: DatabaseSync, event: StoredEvent): void {
  CARD_FOLDS[CARD_ADMITTED]!(db, event)
  foldCardBody(db, event)
  closeDowngradeWaitsTheAdmissionAnswers(db, event)
  closeAmendWaitsTheAdmissionAnswers(db, event)
  closeDecisionWaitsTheAmendAnswers(db, event)
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
    [CARD_ADMITTED]: foldAdmittedWithBody,
  }
}
