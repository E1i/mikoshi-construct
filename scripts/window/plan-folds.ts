import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from '../core/stored.js'
import { CARD_PLANNED, CARD_UNPLANNED, CLOSED_PLAN, OPEN_PLAN, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED } from '../core/events.js'
import { cardIdOf } from '../core/identifiers.js'
import { payloadOf, reject } from '../core/stored.js'

export interface PlanActors {
  owner: string
  recut: string
}

function planText(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : reject(`${field} is empty`)
}

function actorOf(db: DatabaseSync, event: StoredEvent): string | null {
  return (db.prepare('SELECT actor FROM events WHERE id = ?').get(event.id) as { actor: string | null }).actor
}

function ownersPayload(db: DatabaseSync, event: StoredEvent, actors: PlanActors): Record<string, unknown> {
  const actor = actorOf(db, event)
  return actor === actors.owner ? payloadOf(event) : reject(`${event.type} is the owner's, not ${actor}'s`)
}

function recutLinkPayload(db: DatabaseSync, event: StoredEvent, actors: PlanActors): Record<string, unknown> | null {
  if (actorOf(db, event) !== actors.recut)
    return null
  const payload = payloadOf(event)
  return cardIdOf(payload.recut_of) === null ? reject(`${event.type} by ${actors.recut} names no recut_of card`) : payload
}

function openPlanId(db: DatabaseSync, payload: Record<string, unknown>, field = 'plan'): string {
  const planId = planText(payload, field)
  const plan = db.prepare('SELECT state FROM plans WHERE plan_id = ?').get(planId) as { state: string } | undefined
  if (plan?.state !== OPEN_PLAN)
    reject(`plan ${planId} is not open`)
  return planId
}

function itemCards(db: DatabaseSync, planId: string, itemId: string): number[] {
  const item = db.prepare('SELECT cards FROM plan_items WHERE plan_id = ? AND item_id = ?').get(planId, itemId) as { cards: string } | undefined
  return item === undefined ? reject(`plan ${planId} has no item ${itemId}`) : JSON.parse(item.cards) as number[]
}

function releaseOf(db: DatabaseSync, cardId: number): string | null {
  return (db.prepare('SELECT release FROM card_releases WHERE card_id = ?').get(cardId) as { release: string } | undefined)?.release ?? null
}

function putIntoRelease(db: DatabaseSync, cardId: number, release: string, eventId: number): void {
  db.prepare('INSERT INTO card_releases (card_id, release, event_id) VALUES (?, ?, ?) ON CONFLICT (card_id) DO UPDATE SET release = excluded.release, event_id = excluded.event_id')
    .run(cardId, release, eventId)
}

function backfilledCards(payload: Record<string, unknown>): number[] {
  const cards = Array.isArray(payload.cards) ? payload.cards.map(cardIdOf) : []
  return cards.length > 0 && cards.every(card => card !== null) ? cards as number[] : reject('cards is not a list of card numbers')
}

function planOpened(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  const payload = ownersPayload(db, event, actors)
  const planId = planText(payload, 'id')
  if (db.prepare('SELECT 1 FROM plans WHERE plan_id = ?').get(planId) !== undefined)
    reject(`plan ${planId} was opened before`)
  const gate = payload.gate === undefined ? null : planText(payload, 'gate')
  db.prepare('INSERT INTO plans (plan_id, title, goal, plan_file, state, event_id, gate) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(planId, planText(payload, 'title'), planText(payload, 'goal'), planText(payload, 'plan_file'), OPEN_PLAN, event.id, gate)
}

function cardPlanned(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  const payload = recutLinkPayload(db, event, actors) ?? ownersPayload(db, event, actors)
  const release = openPlanId(db, payload, 'release')
  const cardId = event.card_id ?? reject(`${event.type} needs a card_id`)
  if (releaseOf(db, cardId) === release)
    reject(`card ${cardId} is already in release ${release}`)
  putIntoRelease(db, cardId, release, event.id)
}

function cardUnplanned(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  ownersPayload(db, event, actors)
  const cardId = event.card_id ?? reject(`${event.type} needs a card_id`)
  if (releaseOf(db, cardId) === null)
    reject(`card ${cardId} is in no release`)
  db.prepare('DELETE FROM card_releases WHERE card_id = ?').run(cardId)
}

function planBackfilled(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  const payload = ownersPayload(db, event, actors)
  const planId = openPlanId(db, payload)
  const gate = planText(payload, 'gate')
  const cards = backfilledCards(payload)
  db.prepare('UPDATE plans SET gate = ?, event_id = ? WHERE plan_id = ?').run(gate, event.id, planId)
  for (const cardId of cards)
    putIntoRelease(db, cardId, planId, event.id)
}

function planItemAdded(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  const payload = ownersPayload(db, event, actors)
  const planId = openPlanId(db, payload)
  const itemId = planText(payload, 'item')
  if (db.prepare('SELECT 1 FROM plan_items WHERE plan_id = ? AND item_id = ?').get(planId, itemId) !== undefined)
    reject(`plan ${planId} already has item ${itemId}`)
  db.prepare('INSERT INTO plan_items (plan_id, item_id, title, cards, event_id) VALUES (?, ?, ?, ?, ?)')
    .run(planId, itemId, planText(payload, 'title'), '[]', event.id)
}

function planItemLinked(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  const payload = recutLinkPayload(db, event, actors) ?? ownersPayload(db, event, actors)
  const planId = openPlanId(db, payload)
  const itemId = planText(payload, 'item')
  const cardId = cardIdOf(payload.card) ?? reject('card is not a card number')
  const cards = itemCards(db, planId, itemId)
  if (cards.includes(cardId))
    reject(`card ${cardId} is already linked to item ${itemId}`)
  db.prepare('UPDATE plan_items SET cards = ?, event_id = ? WHERE plan_id = ? AND item_id = ?').run(JSON.stringify([...cards, cardId]), event.id, planId, itemId)
}

function planItemRemoved(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  const payload = ownersPayload(db, event, actors)
  const planId = openPlanId(db, payload)
  const itemId = planText(payload, 'item')
  itemCards(db, planId, itemId)
  db.prepare('DELETE FROM plan_items WHERE plan_id = ? AND item_id = ?').run(planId, itemId)
}

function planClosed(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  const planId = openPlanId(db, ownersPayload(db, event, actors))
  db.prepare('UPDATE plans SET state = ?, event_id = ? WHERE plan_id = ?').run(CLOSED_PLAN, event.id, planId)
}

export function foldPlanEvent(db: DatabaseSync, event: StoredEvent, actors: PlanActors): void {
  switch (event.type) {
    case PLAN_OPENED: return planOpened(db, event, actors)
    case PLAN_ITEM_ADDED: return planItemAdded(db, event, actors)
    case PLAN_ITEM_LINKED: return planItemLinked(db, event, actors)
    case PLAN_ITEM_REMOVED: return planItemRemoved(db, event, actors)
    case PLAN_CLOSED: return planClosed(db, event, actors)
    case CARD_PLANNED: return cardPlanned(db, event, actors)
    case CARD_UNPLANNED: return cardUnplanned(db, event, actors)
    case PLAN_BACKFILLED: return planBackfilled(db, event, actors)
    default: reject(`${event.type} is no plan event`)
  }
}
