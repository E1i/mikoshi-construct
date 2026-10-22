import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, CARD_WAITING, CLOSED_PLAN, DECISION_RECORDED, DECISIONS_IMPORTED, OPEN_PLAN, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED, PR_OPENED, WITNESS_DOWNGRADE } from '../core/events.js'
import { CARD_FOLDS, cardLinkObserved, cardPrMerged, cardPrOpened, CARDS_PROJECTION } from './card-automaton.js'
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
import { payloadOf, reject, STORED_COLUMNS } from './stored.js'
import { markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const PREFIX = '[bus:reduce] '
export const PROJECTION_KEYS: Readonly<Record<string, string>> = { prs: 'pr', cards: 'card_id', tasks: 'task_key', mains: 'sha', chains: 'dir', roles: 'role', decisions: 'decision_id', [CARD_BODIES]: 'card_id', plans: 'plan_id', plan_items: 'plan_id, item_id', [OWNER_WAITS]: 'id' }
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
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE state = '${OPEN_WAIT}' AND need = 'merge' AND pr = ?`)
    .run(`PR #${pr} ${merged ? 'merged' : 'closed'}`, event.id, pr)
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
  return need === 'merge' ? pr !== null : command !== null
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
  const id = typeof payload.id === 'string' && WAIT_ID.test(payload.id) ? payload.id : reject('id is not Q<N>')
  const answer = filled(payload.answer) ?? reject('answer is empty')
  const wait = db.prepare('SELECT state FROM owner_waits WHERE id = ?').get(id) as { state: string } | undefined
  if (wait === undefined)
    reject(`${id} was never opened`)
  if (wait.state !== OPEN_WAIT)
    reject(`${id} is already closed`)
  db.prepare(`UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ? WHERE id = ?`).run(answer, event.id, id)
}

export function downgradeWaitId(eventId: number): string {
  return `W${eventId}`
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
  ...OWNER_WAIT_FOLDS,
  ...PLAN_FOLDS,
  [CARD_ADMITTED]: foldAdmittedWithBody,
}

export function reducedThrough(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

export const REDUCE_BATCH = 500
export const SNAPSHOT = 'snapshot'
export const ASIDE = 'aside'
export const SEQUENCE_SNAPSHOT = sequencesOf(SNAPSHOT)

export type ReduceScope = 'pending' | 'rebuild'

const NEVER_REDUCED = 0
const EVERY_EVENT = Number.MAX_SAFE_INTEGER
const PROJECTION_TABLES = Object.keys(PROJECTION_KEYS)
const PROJECTION_SEQUENCES = `name IN (${PROJECTION_TABLES.map(table => `'${table}'`).join(', ')})`
const REDUCED_TYPES = Object.keys(REDUCERS)

function sequencesOf(copy: string): string {
  return `projection_sequence_${copy}`
}

function copyOf(table: string, copy: string): string {
  return `${table}_${copy}`
}

export function snapshotOf(table: string): string {
  return copyOf(table, SNAPSHOT)
}

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

function columnsOf(db: DatabaseSync, table: string): string {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name).join(', ')
}

function copyHolds(db: DatabaseSync, copy: string): boolean {
  return columnsOf(db, sequencesOf(copy)) !== '' && PROJECTION_TABLES.every(table => columnsOf(db, copyOf(table, copy)) === columnsOf(db, table))
}

function copyTableFor(db: DatabaseSync, table: string, copy: string): void {
  if (columnsOf(db, copyOf(table, copy)) !== columnsOf(db, table))
    db.exec(`DROP TABLE IF EXISTS ${copyOf(table, copy)}; CREATE TABLE ${copyOf(table, copy)} AS SELECT * FROM ${table} WHERE 0;`)
}

function saveProjections(db: DatabaseSync, copy: string): void {
  for (const table of PROJECTION_TABLES) {
    copyTableFor(db, table, copy)
    db.exec(`DELETE FROM ${copyOf(table, copy)}; INSERT INTO ${copyOf(table, copy)} SELECT * FROM ${table};`)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ${sequencesOf(copy)} (name TEXT, seq INTEGER); DELETE FROM ${sequencesOf(copy)}; INSERT INTO ${sequencesOf(copy)} (name, seq) SELECT name, seq FROM sqlite_sequence WHERE ${PROJECTION_SEQUENCES};`)
}

function loadProjections(db: DatabaseSync, copy: string): void {
  for (const table of PROJECTION_TABLES)
    db.exec(`DELETE FROM ${table}; INSERT INTO ${table} SELECT * FROM ${copyOf(table, copy)};`)
  db.exec(`DELETE FROM sqlite_sequence WHERE ${PROJECTION_SEQUENCES}; INSERT INTO sqlite_sequence (name, seq) SELECT name, seq FROM ${sequencesOf(copy)};`)
}

function takeSnapshot(db: DatabaseSync, through: number): void {
  saveProjections(db, SNAPSHOT)
  markReduced(db, SNAPSHOT, through)
}

function emptySnapshot(db: DatabaseSync): void {
  for (const table of PROJECTION_TABLES) {
    copyTableFor(db, table, SNAPSHOT)
    db.exec(`DELETE FROM ${snapshotOf(table)};`)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ${SEQUENCE_SNAPSHOT} (name TEXT, seq INTEGER); DELETE FROM ${SEQUENCE_SNAPSHOT};`)
  markReduced(db, SNAPSHOT, NEVER_REDUCED)
}

function snapshotThrough(db: DatabaseSync): number {
  const through = watermarkOf(db, SNAPSHOT)
  if (through !== NEVER_REDUCED && copyHolds(db, SNAPSHOT))
    return through
  emptySnapshot(db)
  return NEVER_REDUCED
}

function clearProjections(db: DatabaseSync): void {
  db.exec(`${PROJECTION_TABLES.map(table => `DELETE FROM ${table};`).join(' ')} DELETE FROM sqlite_sequence WHERE ${PROJECTION_SEQUENCES};`)
}

function foldInOrder(db: DatabaseSync, events: StoredEvent[], count: ReduceCount): void {
  for (const event of events) {
    if (appliedOrRejected(db, event, REDUCERS[event.type]!))
      count.applied += 1
    else
      count.rejected += 1
  }
}

function eventsAfter(db: DatabaseSync, from: number, through: number, limit: number): StoredEvent[] {
  return db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id > ? AND id <= ? AND legacy = 0 AND type IN (${REDUCED_TYPES.map(() => '?').join(', ')}) ORDER BY id LIMIT ?`)
    .all(from, through, ...REDUCED_TYPES, limit) as unknown as StoredEvent[]
}

function markInOrderThrough(db: DatabaseSync, through: number): void {
  db.exec(`PRAGMA user_version = ${through}`)
  takeSnapshot(db, through)
  for (const projection of INCREMENTAL_PROJECTIONS) {
    markReduced(db, projection.table, through)
    reduceProjection(db, projection)
  }
}

function rebuildAll(db: DatabaseSync, count: ReduceCount): void {
  clearProjections(db)
  const through = lastEventId(db)
  foldInOrder(db, eventsAfter(db, NEVER_REDUCED, through, EVERY_EVENT), count)
  markInOrderThrough(db, through)
}

function foldBesideTheLiveProjections(db: DatabaseSync, events: StoredEvent[], through: number, count: ReduceCount): void {
  saveProjections(db, ASIDE)
  loadProjections(db, SNAPSHOT)
  foldInOrder(db, events, count)
  takeSnapshot(db, through)
  loadProjections(db, ASIDE)
}

function reduceBatch(db: DatabaseSync, target: number, count: ReduceCount): boolean {
  return inTransaction(db, () => {
    const from = snapshotThrough(db)
    const live = reducedThrough(db)
    if (from >= target && live === from)
      return false
    const events = eventsAfter(db, from, target, REDUCE_BATCH)
    const through = events.length < REDUCE_BATCH ? Math.max(from, target) : events.at(-1)!.id
    if (live !== from && through < target) {
      foldBesideTheLiveProjections(db, events, through, count)
      return false
    }
    loadProjections(db, SNAPSHOT)
    foldInOrder(db, events, count)
    markInOrderThrough(db, through)
    return through < target
  })
}

export function reduce(db: DatabaseSync, scope: ReduceScope = 'pending'): ReduceCount {
  const count: ReduceCount = { applied: 0, rejected: 0 }
  if (scope === 'rebuild') {
    inTransaction(db, () => rebuildAll(db, count))
    return count
  }
  const target = lastEventId(db)
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
