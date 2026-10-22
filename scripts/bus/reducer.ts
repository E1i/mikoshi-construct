import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, CLOSED_PLAN, OPEN_PLAN, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED, PR_OPENED } from '../core/events.js'
import { CARD_FOLDS, cardLinkObserved, cardPrMerged, cardPrOpened, CARDS_PROJECTION } from './card-automaton.js'
import { CARD_BODIES, foldCardBody } from './card-bodies.js'
import { CHAINS_PROJECTION } from './chain.js'
import { defaultBusPath, inTransaction, openBus } from './db.js'
import { DECISION_FOLDS } from './decisions.js'
import { cardIdOf, isFullSha, prOf } from './identifiers.js'
import { OWNER } from './inbox.js'
import { TASKS_PROJECTION } from './queue.js'
import { appliedOrRejected } from './rejection.js'
import { ROLE_FOLDS, ROLES_PROJECTION } from './role.js'
import { payloadOf, reject, STORED_COLUMNS } from './stored.js'
import { markReduced } from './watermark.js'

export const PREFIX = '[bus:reduce] '
export const PROJECTION_KEYS: Readonly<Record<string, string>> = { prs: 'pr', cards: 'card_id', tasks: 'task_key', mains: 'sha', chains: 'dir', roles: 'role', decisions: 'decision_id', [CARD_BODIES]: 'card_id', plans: 'plan_id', plan_items: 'plan_id, item_id' }
export const INCREMENTAL_PROJECTIONS: readonly IncrementalProjection[] = [ROLES_PROJECTION, TASKS_PROJECTION, CHAINS_PROJECTION, CARDS_PROJECTION]

const MERGEABLE = new Set(['clean', 'behind', 'dirty', 'blocked'])
const CI = new Set(['pending', 'green', 'red'])

interface PrRow {
  pr: number
  card_id: number | null
  base: string | null
  head: string | null
  state: string | null
  mergeable: string | null
  ci: string | null
  verdict_on_head: string | null
  auto_merge: number | null
  draft: number | null
  event_id: number
  body_sha: string | null
}

interface CardRow {
  card_id: number
  pr: number | null
}

export interface ReduceCount {
  applied: number
  rejected: number
}

function boolean(payload: Record<string, unknown>, field: string): boolean {
  const value = payload[field]
  return typeof value === 'boolean' ? value : reject(`${field} is not a boolean`)
}

function oneOf(payload: Record<string, unknown>, field: string, allowed: Set<string>): string {
  const value = payload[field]
  return typeof value === 'string' && allowed.has(value) ? value : reject(`${field} is not one of ${[...allowed].join(' | ')}`)
}

function requiredPr(event: StoredEvent): number {
  return event.pr ?? reject(`${event.type} needs a pr`)
}

function prRow(db: DatabaseSync, pr: number): PrRow | undefined {
  return db.prepare('SELECT * FROM prs WHERE pr = ?').get(pr) as PrRow | undefined
}

function cardRow(db: DatabaseSync, cardId: number): CardRow | undefined {
  return db.prepare('SELECT card_id, pr FROM cards WHERE card_id = ?').get(cardId) as CardRow | undefined
}

function cardOfPr(db: DatabaseSync, pr: number): number | null {
  return (db.prepare('SELECT card_id FROM cards WHERE pr = ?').get(pr) as { card_id: number } | undefined)?.card_id ?? null
}

function linkCard(db: DatabaseSync, cardId: number, pr: number, eventId: number): void {
  const card = cardRow(db, cardId)
  if (card?.pr === pr)
    return
  if (card !== undefined && card.pr !== null) {
    const linked = prRow(db, card.pr)
    if (linked === undefined || linked.state === 'open')
      reject(`card ${cardId} is linked to pr ${card.pr}, which is still open`)
    if (linked.state === 'merged')
      reject(`card ${cardId} is linked to pr ${card.pr}, which is merged`)
  }
  db.prepare(`
    INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, NULL, ?, ?)
    ON CONFLICT (card_id) DO UPDATE SET pr = excluded.pr, event_id = excluded.event_id
  `).run(cardId, pr, eventId)
}

function prObserved(db: DatabaseSync, event: StoredEvent): void {
  const pr = requiredPr(event)
  const payload = payloadOf(event)
  const base = typeof payload.base === 'string' && payload.base !== '' ? payload.base : reject('base is not a branch name')
  const head = isFullSha(payload.head) ? payload.head : reject('head is not a full sha')
  if (event.head !== null && event.head !== head)
    reject(`the event head ${event.head} is not the payload head ${head}`)
  const mergeable = oneOf(payload, 'mergeable', MERGEABLE)
  const ci = oneOf(payload, 'ci', CI)
  const verdict = payload.verdict_on_head ?? null
  if (verdict !== null && typeof verdict !== 'string')
    reject('verdict_on_head is not a string')
  const autoMerge = boolean(payload, 'auto_merge')
  const draft = boolean(payload, 'draft')
  const bodySha = payload.body_sha ?? null
  if (bodySha !== null && typeof bodySha !== 'string')
    reject('body_sha is not a string')
  const known = prRow(db, pr)
  if (known?.state === 'merged')
    reject(`pr ${pr} is merged`)
  if (known?.card_id != null && event.card_id !== null && known.card_id !== event.card_id)
    reject(`pr ${pr} belongs to card ${known.card_id}, not ${event.card_id}`)
  const cardId = event.card_id ?? known?.card_id ?? cardOfPr(db, pr)
  if (cardId !== null) {
    linkCard(db, cardId, pr, event.id)
    cardLinkObserved(db, cardId, event.id)
  }
  db.prepare(`
    INSERT INTO prs (pr, card_id, base, head, state, mergeable, ci, verdict_on_head, auto_merge, draft, event_id, body_sha)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pr) DO UPDATE SET card_id = excluded.card_id, base = excluded.base, head = excluded.head,
      state = 'open', mergeable = excluded.mergeable, ci = excluded.ci, verdict_on_head = excluded.verdict_on_head,
      auto_merge = excluded.auto_merge, draft = excluded.draft, event_id = excluded.event_id, body_sha = excluded.body_sha
  `).run(pr, cardId, base, head, mergeable, ci, verdict, autoMerge ? 1 : 0, draft ? 1 : 0, event.id, bodySha)
}

function prClosed(db: DatabaseSync, event: StoredEvent): void {
  const pr = requiredPr(event)
  const merged = boolean(payloadOf(event), 'merged')
  const known = prRow(db, pr) ?? reject(`pr ${pr} was never observed`)
  if (known.state === 'merged')
    reject(`pr ${pr} is already merged`)
  db.prepare('UPDATE prs SET state = ?, event_id = ? WHERE pr = ?').run(merged ? 'merged' : 'closed', event.id, pr)
  if (merged && known.card_id !== null)
    cardPrMerged(db, known.card_id, event.id)
}

function mainAdvanced(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  if (!isFullSha(payload.sha))
    reject('sha is not a full sha')
  const touches = boolean(payload, 'touches_mechanics')
  db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, ?, ?)').run(payload.sha, touches ? 1 : 0, event.id)
}

function foldAdmittedWithBody(db: DatabaseSync, event: StoredEvent): void {
  CARD_FOLDS[CARD_ADMITTED]!(db, event)
  foldCardBody(db, event)
}

function prOpened(db: DatabaseSync, event: StoredEvent): void {
  const pr = prOf(payloadOf(event).pr) ?? event.pr ?? reject(`${PR_OPENED} needs a pr`)
  const cardId = event.card_id ?? reject(`${PR_OPENED} needs a card_id`)
  const known = prRow(db, pr)
  if (known?.card_id != null && known.card_id !== cardId)
    reject(`pr ${pr} belongs to card ${known.card_id}, not ${cardId}`)
  const linkedBefore = cardRow(db, cardId)?.pr ?? null
  linkCard(db, cardId, pr, event.id)
  cardPrOpened(db, cardId, pr, linkedBefore, event.id)
  if (known !== undefined)
    db.prepare('UPDATE prs SET card_id = ? WHERE pr = ?').run(cardId, pr)
}

function planText(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : reject(`${field} is empty`)
}

function ownersPlanPayload(db: DatabaseSync, event: StoredEvent): Record<string, unknown> {
  const actor = (db.prepare('SELECT actor FROM events WHERE id = ?').get(event.id) as { actor: string | null }).actor
  return actor === OWNER ? payloadOf(event) : reject(`${event.type} is the owner's, not ${actor}'s`)
}

function openPlanId(db: DatabaseSync, payload: Record<string, unknown>): string {
  const planId = planText(payload, 'plan')
  const plan = db.prepare('SELECT state FROM plans WHERE plan_id = ?').get(planId) as { state: string } | undefined
  if (plan?.state !== OPEN_PLAN)
    reject(`plan ${planId} is not open`)
  return planId
}

function itemCards(db: DatabaseSync, planId: string, itemId: string): number[] {
  const item = db.prepare('SELECT cards FROM plan_items WHERE plan_id = ? AND item_id = ?').get(planId, itemId) as { cards: string } | undefined
  return item === undefined ? reject(`plan ${planId} has no item ${itemId}`) : JSON.parse(item.cards) as number[]
}

function planOpened(db: DatabaseSync, event: StoredEvent): void {
  const payload = ownersPlanPayload(db, event)
  const planId = planText(payload, 'id')
  if (db.prepare('SELECT 1 FROM plans WHERE plan_id = ?').get(planId) !== undefined)
    reject(`plan ${planId} was opened before`)
  db.prepare('INSERT INTO plans (plan_id, title, goal, plan_file, state, event_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(planId, planText(payload, 'title'), planText(payload, 'goal'), planText(payload, 'plan_file'), OPEN_PLAN, event.id)
}

function planItemAdded(db: DatabaseSync, event: StoredEvent): void {
  const payload = ownersPlanPayload(db, event)
  const planId = openPlanId(db, payload)
  const itemId = planText(payload, 'item')
  if (db.prepare('SELECT 1 FROM plan_items WHERE plan_id = ? AND item_id = ?').get(planId, itemId) !== undefined)
    reject(`plan ${planId} already has item ${itemId}`)
  db.prepare('INSERT INTO plan_items (plan_id, item_id, title, cards, event_id) VALUES (?, ?, ?, ?, ?)')
    .run(planId, itemId, planText(payload, 'title'), '[]', event.id)
}

function planItemLinked(db: DatabaseSync, event: StoredEvent): void {
  const payload = ownersPlanPayload(db, event)
  const planId = openPlanId(db, payload)
  const itemId = planText(payload, 'item')
  const cardId = cardIdOf(payload.card) ?? reject('card is not a card number')
  const cards = itemCards(db, planId, itemId)
  if (cards.includes(cardId))
    reject(`card ${cardId} is already linked to item ${itemId}`)
  db.prepare('UPDATE plan_items SET cards = ?, event_id = ? WHERE plan_id = ? AND item_id = ?').run(JSON.stringify([...cards, cardId]), event.id, planId, itemId)
}

function planItemRemoved(db: DatabaseSync, event: StoredEvent): void {
  const payload = ownersPlanPayload(db, event)
  const planId = openPlanId(db, payload)
  const itemId = planText(payload, 'item')
  itemCards(db, planId, itemId)
  db.prepare('DELETE FROM plan_items WHERE plan_id = ? AND item_id = ?').run(planId, itemId)
}

function planClosed(db: DatabaseSync, event: StoredEvent): void {
  const planId = openPlanId(db, ownersPlanPayload(db, event))
  db.prepare('UPDATE plans SET state = ?, event_id = ? WHERE plan_id = ?').run(CLOSED_PLAN, event.id, planId)
}

export const PLAN_FOLDS: Record<string, Fold> = {
  [PLAN_OPENED]: planOpened,
  [PLAN_ITEM_ADDED]: planItemAdded,
  [PLAN_ITEM_LINKED]: planItemLinked,
  [PLAN_ITEM_REMOVED]: planItemRemoved,
  [PLAN_CLOSED]: planClosed,
}

const REDUCERS: Record<string, Fold> = {
  'pr.observed': prObserved,
  'pr.closed': prClosed,
  'main.advanced': mainAdvanced,
  [PR_OPENED]: prOpened,
  ...TASKS_PROJECTION.folds,
  ...CHAINS_PROJECTION.folds,
  ...ROLE_FOLDS,
  ...DECISION_FOLDS,
  ...CARD_FOLDS,
  ...PLAN_FOLDS,
  [CARD_ADMITTED]: foldAdmittedWithBody,
}

export function reducedThrough(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

export function reduce(db: DatabaseSync): ReduceCount {
  return inTransaction(db, () => {
    db.exec(`${Object.keys(PROJECTION_KEYS).map(table => `DELETE FROM ${table};`).join(' ')} DELETE FROM sqlite_sequence WHERE name = 'tasks';`)
    const through = Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
    db.exec(`PRAGMA user_version = ${through}`)
    const events = db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE legacy = 0 ORDER BY id`).all() as unknown as StoredEvent[]
    const count: ReduceCount = { applied: 0, rejected: 0 }
    for (const event of events) {
      const apply = REDUCERS[event.type]
      if (apply === undefined)
        continue
      if (appliedOrRejected(db, event, apply))
        count.applied += 1
      else
        count.rejected += 1
    }
    for (const projection of INCREMENTAL_PROJECTIONS)
      markReduced(db, projection.table, through)
    return count
  })
}

export function projectionDump(db: DatabaseSync): string {
  return JSON.stringify(Object.fromEntries(Object.entries(PROJECTION_KEYS).map(([table, key]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()])))
}

function main(): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    const count = reduce(db)
    console.log(`${PREFIX}${busPath}: applied ${count.applied}, rejected ${count.rejected}`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
