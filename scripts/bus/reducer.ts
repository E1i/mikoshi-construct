import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_MOVED, CARD_WAITING, CLOSED_PLAN, DECISION_RECORDED, DECISIONS_IMPORTED, MERGE_DONE, OPEN_PLAN, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED, PR_OPENED, WITNESS_DOWNGRADE } from '../core/events.js'
import { CARD_FOLDS, cardLinkObserved, cardPrMerged, cardPrOpened, CARDS_PROJECTION, CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from './card-automaton.js'
import { CARD_BODIES, foldCardBody } from './card-bodies.js'
import { CHAINS_PROJECTION } from './chain.js'
import { CLOSED_WAIT, defaultBusPath, inTransaction, isOwnerWaitNeed, OPEN_WAIT, openBus, OWNER_WAIT_NEEDS, OWNER_WAITS, WAIT_ID } from './db.js'
import { DECISION_FOLDS } from './decisions.js'
import { cardIdOf, isFullSha, prOf } from './identifiers.js'
import { OWNER } from './inbox.js'
import { allowLiveCommand, namesQueueLive } from './live-decision.js'
import { TASKS_PROJECTION } from './queue.js'
import { appliedOrRejected } from './rejection.js'
import { ROLE_FOLDS, ROLES_PROJECTION } from './role.js'
import { RECUT_ACTOR } from './round-limit-decision.js'
import { payloadOf, reject, STORED_COLUMNS } from './stored.js'
import { markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const PREFIX = '[bus:reduce] '
export const PROJECTION_KEYS: Readonly<Record<string, string>> = { prs: 'pr', cards: 'card_id', tasks: 'task_key', mains: 'sha', chains: 'dir', roles: 'role', decisions: 'decision_id', [CARD_BODIES]: 'card_id', plans: 'plan_id', plan_items: 'plan_id, item_id', [OWNER_WAITS]: 'id' }
export const INCREMENTAL_PROJECTIONS: readonly IncrementalProjection[] = [ROLES_PROJECTION, TASKS_PROJECTION, CHAINS_PROJECTION, CARDS_PROJECTION]

const DOWNGRADE_WAIT_PREFIX = 'W'
const DOWNGRADE_WAIT_ID = new RegExp(`^${DOWNGRADE_WAIT_PREFIX}\\d+$`)
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
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND need = 'merge' AND pr = ?`)
    .run(`PR #${pr} ${merged ? 'merged' : 'closed'}`, event.id, pr)
  closeWaitsOfAnEndedCard(db, known.card_id, event.id)
}

const ENDED_CARD_STATES: ReadonlySet<string | null> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])

function closeWaitsOfAnEndedCard(db: DatabaseSync, cardId: number | null, eventId: number): void {
  if (cardId === null)
    return
  const state = (db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined)?.state ?? null
  if (!ENDED_CARD_STATES.has(state))
    return
  const sparingItsQuestions = state === MERGED_CARD ? ` AND NOT (need = 'decision' AND id NOT LIKE '${DOWNGRADE_WAIT_PREFIX}%')` : ''
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND card_id = ?${sparingItsQuestions}`)
    .run(`card #${cardId} ${state}`, eventId, cardId)
}

function foldEndingTheWaitsOfAnEndedCard(db: DatabaseSync, event: StoredEvent): void {
  CARD_FOLDS[event.type]!(db, event)
  closeWaitsOfAnEndedCard(db, event.card_id, event.id)
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

function foldDropNamingItsChildren(db: DatabaseSync, event: StoredEvent): void {
  checkTheChildrenADropNames(event)
  foldEndingTheWaitsOfAnEndedCard(db, event)
}

function mainAdvanced(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  if (!isFullSha(payload.sha))
    reject('sha is not a full sha')
  const touches = boolean(payload, 'touches_mechanics')
  db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, ?, ?)').run(payload.sha, touches ? 1 : 0, event.id)
}

function closeDowngradeWaitsTheAdmissionAnswers(db: DatabaseSync, event: StoredEvent): void {
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND card_id = ? AND id LIKE '${DOWNGRADE_WAIT_PREFIX}%' AND event_id < ?`)
    .run(`card #${event.card_id} admitted`, event.id, event.card_id, event.id)
}

function foldAdmittedWithBody(db: DatabaseSync, event: StoredEvent): void {
  CARD_FOLDS[CARD_ADMITTED]!(db, event)
  foldCardBody(db, event)
  closeDowngradeWaitsTheAdmissionAnswers(db, event)
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

export function decisionsAddCommand(text: string): string {
  return `pnpm decisions:add "${text}"`
}

function filled(value: unknown): string | null {
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

function foldOwnerWaitOpened(db: DatabaseSync, event: StoredEvent): void {
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
    .run(id, need, text, command, card, pr, event.ts, event.id)
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

function foldWitnessDowngradeWait(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  if (payload.reason !== WITNESS_DOWNGRADE)
    return
  const cardId = event.card_id ?? reject('a witness downgrade names no card')
  const actions = Array.isArray(payload.actions) ? payload.actions.map(filled) : []
  if (actions.length === 0 || actions.includes(null))
    reject('a witness downgrade names no action for the owner')
  db.prepare(`INSERT INTO owner_waits (id, need, text, command, card_id, pr, state, answer, opened_at, event_id) VALUES (?, 'decision', ?, NULL, ?, NULL, '${OPEN_WAIT}', NULL, ?, ?)`)
    .run(downgradeWaitId(event.id), actions.join('; '), cardId, event.ts, event.id)
}

const QUEUE_NAME = /^[\w-]+$/

function commandsTheDecisionAnswers(text: string): string[] {
  const queue = text.trim().split(/\s+/).at(-1) ?? ''
  return QUEUE_NAME.test(queue) && namesQueueLive(text, queue) ? [decisionsAddCommand(text), allowLiveCommand(queue)] : [decisionsAddCommand(text)]
}

function closeWaitsTheDecisionsAnswer(db: DatabaseSync, event: StoredEvent): void {
  const decisions = db.prepare('SELECT decision_id, text, scope FROM decisions WHERE event_id = ?').all(event.id) as { decision_id: number, text: string, scope: string | null }[]
  for (const decision of decisions) {
    db.prepare(`
      UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ?
      WHERE state = '${OPEN_WAIT}' AND (command IN (SELECT value FROM json_each(?)) OR (need = 'decision' AND card_id IN (SELECT value FROM json_each(?))))
    `).run(`D-${decision.decision_id}`, event.id, JSON.stringify(commandsTheDecisionAnswers(decision.text)), decision.scope ?? '[]')
  }
}

function foldDecisionClosingWaits(db: DatabaseSync, event: StoredEvent): void {
  DECISION_FOLDS[event.type]!(db, event)
  closeWaitsTheDecisionsAnswer(db, event)
}

export const OWNER_WAIT_FOLDS: Record<string, Fold> = {
  [OWNER_WAIT_OPENED]: foldOwnerWaitOpened,
  [OWNER_WAIT_CLOSED]: foldOwnerWaitClosed,
  [CARD_WAITING]: foldWitnessDowngradeWait,
  [DECISION_RECORDED]: foldDecisionClosingWaits,
  [DECISIONS_IMPORTED]: foldDecisionClosingWaits,
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

function recutLinkPayload(db: DatabaseSync, event: StoredEvent): Record<string, unknown> | null {
  const actor = (db.prepare('SELECT actor FROM events WHERE id = ?').get(event.id) as { actor: string | null }).actor
  if (actor !== RECUT_ACTOR)
    return null
  const payload = payloadOf(event)
  return cardIdOf(payload.recut_of) === null ? reject(`${event.type} by ${RECUT_ACTOR} names no recut_of card`) : payload
}

function planItemLinked(db: DatabaseSync, event: StoredEvent): void {
  const payload = recutLinkPayload(db, event) ?? ownersPlanPayload(db, event)
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
  ...OWNER_WAIT_FOLDS,
  ...PLAN_FOLDS,
  [MERGE_DONE]: foldEndingTheWaitsOfAnEndedCard,
  [CARD_CLOSED]: foldEndingTheWaitsOfAnEndedCard,
  [CARD_MOVED]: foldEndingTheWaitsOfAnEndedCard,
  [CARD_DROPPED]: foldDropNamingItsChildren,
  [CARD_ADMITTED]: foldAdmittedWithBody,
}

export function reducedThrough(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

export const REDUCE_BATCH = 500
export const SNAPSHOT = 'snapshot'
export const DIRTY_ROWS = 'projection_dirty'

export type ReduceScope = 'pending' | 'rebuild'

const NO_SECOND_KEY = `''`
const PROJECTION_TABLES = Object.keys(PROJECTION_KEYS)
const PROJECTION_SEQUENCES = `name IN (${PROJECTION_TABLES.map(table => `'${table}'`).join(', ')})`
const SEQUENCE_SNAPSHOT = 'projection_sequence_snapshot'
const REDUCED_TYPES = Object.keys(REDUCERS)
const ROW_WRITES = { insert: ['NEW'], update: ['OLD', 'NEW'], delete: ['OLD'] } as const
const FOREIGN_REFERENCE = /\s+REFERENCES\s+\w+\s*\(\w+\)/g

function snapshotOf(table: string): string {
  return `${table}_${SNAPSHOT}`
}

function keysOf(table: string): string {
  return PROJECTION_KEYS[table]!
}

function dirtyKeysOf(table: string): string {
  const second = keysOf(table).includes(',') ? 'k1, k2' : 'k1'
  return `(${keysOf(table)}) IN (SELECT ${second} FROM ${DIRTY_ROWS} WHERE tbl = '${table}')`
}

function triggerOf(table: string, write: keyof typeof ROW_WRITES): string {
  return `${DIRTY_ROWS}_${table}_${write}`
}

function triggerNames(): string[] {
  return PROJECTION_TABLES.flatMap(table => Object.keys(ROW_WRITES).map(write => triggerOf(table, write as keyof typeof ROW_WRITES)))
}

function markRowDirty(table: string, row: string): string {
  const [k1, k2] = [...keysOf(table).split(', ').map(key => `${row}.${key}`), NO_SECOND_KEY]
  return `INSERT INTO ${DIRTY_ROWS} (tbl, k1, k2) SELECT '${table}', ${k1}, ${k2} WHERE NOT EXISTS (SELECT 1 FROM ${DIRTY_ROWS} WHERE tbl = '${table}' AND k1 IS ${k1} AND k2 IS ${k2});`
}

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

function columnsOf(db: DatabaseSync, table: string): string {
  return (db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[]).map(column => column.name).join(', ')
}

function snapshotHolds(db: DatabaseSync): boolean {
  const triggers = Number((db.prepare(`SELECT count(*) AS n FROM main.sqlite_master WHERE type = 'trigger' AND name IN (SELECT value FROM json_each(?))`).get(JSON.stringify(triggerNames())) as { n: number }).n)
  return watermarkOf(db, SNAPSHOT) === reducedThrough(db)
    && triggers === triggerNames().length
    && columnsOf(db, SEQUENCE_SNAPSHOT) !== ''
    && PROJECTION_TABLES.every(table => columnsOf(db, snapshotOf(table)) === columnsOf(db, table))
}

function trackDirtyRows(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${DIRTY_ROWS} (tbl TEXT, k1, k2, PRIMARY KEY (tbl, k1, k2)); DELETE FROM ${DIRTY_ROWS};`)
  for (const table of PROJECTION_TABLES) {
    for (const [write, rows] of Object.entries(ROW_WRITES)) {
      const trigger = triggerOf(table, write as keyof typeof ROW_WRITES)
      db.exec(`DROP TRIGGER IF EXISTS main.${trigger}; CREATE TRIGGER main.${trigger} AFTER ${write.toUpperCase()} ON ${table} BEGIN ${rows.map(row => markRowDirty(table, row)).join(' ')} END;`)
    }
  }
}

function takeWholeSnapshot(db: DatabaseSync): void {
  for (const table of PROJECTION_TABLES) {
    db.exec(`DROP TABLE IF EXISTS main.${snapshotOf(table)}; CREATE TABLE main.${snapshotOf(table)} AS SELECT * FROM main.${table};`)
    db.exec(`CREATE UNIQUE INDEX main.${snapshotOf(table)}_key ON ${snapshotOf(table)} (${keysOf(table)});`)
  }
  db.exec(`DROP TABLE IF EXISTS main.${SEQUENCE_SNAPSHOT}; CREATE TABLE main.${SEQUENCE_SNAPSHOT} AS SELECT name, seq FROM main.sqlite_sequence WHERE ${PROJECTION_SEQUENCES};`)
}

function copySequences(db: DatabaseSync, from: string, to: string): void {
  db.exec(`DELETE FROM ${to} WHERE ${PROJECTION_SEQUENCES}; INSERT INTO ${to} (name, seq) SELECT name, seq FROM ${from} WHERE ${PROJECTION_SEQUENCES};`)
}

function restoreDirtyRows(db: DatabaseSync): void {
  for (const table of PROJECTION_TABLES)
    db.exec(`DELETE FROM main.${table} WHERE ${dirtyKeysOf(table)}; INSERT INTO main.${table} SELECT * FROM main.${snapshotOf(table)} WHERE ${dirtyKeysOf(table)};`)
  copySequences(db, `main.${SEQUENCE_SNAPSHOT}`, 'main.sqlite_sequence')
  db.exec(`DELETE FROM ${DIRTY_ROWS};`)
}

function snapshotDirtyRows(db: DatabaseSync): void {
  for (const table of PROJECTION_TABLES)
    db.exec(`DELETE FROM main.${snapshotOf(table)} WHERE ${dirtyKeysOf(table)}; INSERT INTO main.${snapshotOf(table)} SELECT * FROM main.${table} WHERE ${dirtyKeysOf(table)};`)
  copySequences(db, 'main.sqlite_sequence', `main.${SEQUENCE_SNAPSHOT}`)
  db.exec(`DELETE FROM ${DIRTY_ROWS};`)
}

function foldInOrder(db: DatabaseSync, events: StoredEvent[], count: ReduceCount): void {
  for (const event of events) {
    if (appliedOrRejected(db, event, REDUCERS[event.type]!))
      count.applied += 1
    else
      count.rejected += 1
  }
}

function eventsAfter(db: DatabaseSync, from: number, through: number): StoredEvent[] {
  return db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id > ? AND id <= ? AND legacy = 0 AND type IN (${REDUCED_TYPES.map(() => '?').join(', ')}) ORDER BY id LIMIT ?`)
    .all(from, through, ...REDUCED_TYPES, REDUCE_BATCH) as unknown as StoredEvent[]
}

function batchThrough(events: StoredEvent[], from: number, target: number): number {
  return events.length < REDUCE_BATCH ? Math.max(from, target) : events.at(-1)!.id
}

function markInOrderThrough(db: DatabaseSync, through: number): void {
  db.exec(`PRAGMA user_version = ${through}`)
  markReduced(db, SNAPSHOT, through)
  for (const projection of INCREMENTAL_PROJECTIONS) {
    markReduced(db, projection.table, through)
    reduceProjection(db, projection)
  }
}

function dropShadows(db: DatabaseSync): void {
  for (const table of PROJECTION_TABLES)
    db.exec(`DROP TABLE IF EXISTS temp.${table};`)
}

function shadowTheProjections(db: DatabaseSync): void {
  dropShadows(db)
  for (const table of PROJECTION_TABLES) {
    const { sql } = db.prepare(`SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string }
    db.exec(sql.replace(/^CREATE TABLE/, 'CREATE TEMP TABLE').replace(FOREIGN_REFERENCE, ''))
  }
  db.exec(`DELETE FROM temp.sqlite_sequence WHERE ${PROJECTION_SEQUENCES};`)
}

function publishTheShadows(db: DatabaseSync, through: number): void {
  for (const table of PROJECTION_TABLES)
    db.exec(`DELETE FROM main.${table}; INSERT INTO main.${table} SELECT * FROM temp.${table};`)
  copySequences(db, 'temp.sqlite_sequence', 'main.sqlite_sequence')
  dropShadows(db)
  takeWholeSnapshot(db)
  trackDirtyRows(db)
  markInOrderThrough(db, through)
}

function buildBesideTheLiveProjections(db: DatabaseSync, target: number, count: ReduceCount): void {
  shadowTheProjections(db)
  try {
    let from = 0
    while (from < target) {
      from = inTransaction(db, () => {
        const events = eventsAfter(db, from, target)
        foldInOrder(db, events, count)
        return batchThrough(events, from, target)
      })
    }
    inTransaction(db, () => publishTheShadows(db, target))
  }
  finally {
    dropShadows(db)
  }
}

function reduceBatch(db: DatabaseSync, target: number, count: ReduceCount): boolean {
  return inTransaction(db, () => {
    const from = reducedThrough(db)
    if (from >= target)
      return false
    const events = eventsAfter(db, from, target)
    const through = batchThrough(events, from, target)
    restoreDirtyRows(db)
    foldInOrder(db, events, count)
    snapshotDirtyRows(db)
    markInOrderThrough(db, through)
    return through < target
  })
}

export function reduce(db: DatabaseSync, scope: ReduceScope = 'pending'): ReduceCount {
  const count: ReduceCount = { applied: 0, rejected: 0 }
  const target = lastEventId(db)
  if (scope === 'rebuild' || !snapshotHolds(db))
    buildBesideTheLiveProjections(db, target, count)
  let another = true
  while (another)
    another = reduceBatch(db, target, count)
  return count
}

export function projectionDump(db: DatabaseSync): string {
  return JSON.stringify(Object.fromEntries(Object.entries(PROJECTION_KEYS).map(([table, key]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()])))
}

function main(): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    const count = reduce(db, 'rebuild')
    console.log(`${PREFIX}${busPath}: applied ${count.applied}, rejected ${count.rejected}`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
