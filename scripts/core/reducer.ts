import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from './events.js'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busProjections } from '../supervisor/composition.js'
import { IN_ORDER_MARK, latestOfEachType, REDUCED_IN_ORDER } from './bus-readings.js'
import { appendEvent, CLOSED_WAIT, defaultBusPath, inTransaction, isOwnerWaitNeed, OPEN_WAIT, openBus, OWNER_WAIT_NEEDS, OWNER_WAITS, WAIT_ID } from './db.js'
import { CARD_WAITING, catalogued, DECISION_RECORDED, DECISIONS_CUT_OVER, DECISIONS_IMPORTED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, WITNESS_DOWNGRADE } from './events.js'
import { prOf } from './identifiers.js'
import { appliedOrRejected } from './rejection.js'
import { payloadOf, reject, STORED_COLUMNS } from './stored.js'
import { markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const PREFIX = '[bus:reduce] '
export const PROJECTION_KEYS: Readonly<Record<string, string>> = { prs: 'pr', cards: 'card_id', tasks: 'task_key', mains: 'sha', chains: 'dir', roles: 'role', decisions: 'decision_id', card_bodies: 'card_id', plans: 'plan_id', card_releases: 'card_id', plan_items: 'plan_id, item_id', [OWNER_WAITS]: 'id' }

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

export interface ReduceCount {
  applied: number
  rejected: number
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

function closeWaitsTheDecisionsAnswer(db: DatabaseSync, event: StoredEvent, parts: OwnerWaitParts): void {
  for (const decision of parts.answersOfTheDecisions(db, event.id)) {
    const named = JSON.stringify(decision.named)
    db.prepare(`
      UPDATE owner_waits SET state = '${CLOSED_WAIT}', answer = ?, event_id = ?
      WHERE state = '${OPEN_WAIT}' AND (event_id IN (SELECT id FROM events WHERE type = '${OWNER_WAIT_OPENED}' AND json_extract(payload, '$.command') IN (SELECT value FROM json_each(?))) OR (need IN ('decision', 'command') AND card_id IN (SELECT value FROM json_each(?)) AND (json_array_length(?) = 0 OR id IN (SELECT value FROM json_each(?)))))
    `).run(decision.answer, event.id, JSON.stringify(decision.commands), decision.scope, named, named)
  }
}

function decisionsCutOverOf(db: DatabaseSync): number | null {
  return latestOfEachType(db, [DECISIONS_CUT_OVER])[0]?.latest ?? null
}

function markTheDecisionsCutOver(db: DatabaseSync, ts: string): void {
  appendEvent(db, { ts, type: DECISIONS_CUT_OVER, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: DECISIONS_CUT_OVER, payload: {}, legacy: false })
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

export function reducedTypesOf(folds: Record<string, Fold>): EventType[] {
  return Object.keys(folds).map(catalogued)
}

export interface Projections {
  folds: readonly Readonly<Record<string, Fold>>[]
  incremental: readonly IncrementalProjection[]
}

interface Reduction {
  folds: Readonly<Record<string, Fold>>
  types: readonly EventType[]
  incremental: readonly IncrementalProjection[]
}

function reductionOf(projections: Projections): Reduction {
  const folds: Record<string, Fold> = Object.assign({}, ...projections.folds)
  return { folds, types: reducedTypesOf(folds), incremental: projections.incremental }
}

export function reducedTypes(projections: Projections): EventType[] {
  return [...reductionOf(projections).types]
}

export function reducedThrough(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

export const REDUCE_BATCH = 500
export const SNAPSHOT = IN_ORDER_MARK
export const DIRTY_ROWS = 'projection_dirty'

export type ReduceScope = 'pending' | 'rebuild'

const NO_SECOND_KEY = `''`
const PROJECTION_TABLES = Object.keys(PROJECTION_KEYS)
const PROJECTION_SEQUENCES = `name IN (${PROJECTION_TABLES.map(table => `'${table}'`).join(', ')})`
const SEQUENCE_SNAPSHOT = 'projection_sequence_snapshot'
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

function foldInOrder(db: DatabaseSync, events: StoredEvent[], count: ReduceCount, folds: Reduction['folds']): void {
  for (const event of events) {
    if (appliedOrRejected(db, event, folds[event.type]!))
      count.applied += 1
    else
      count.rejected += 1
  }
}

function eventsAfter(db: DatabaseSync, from: number, through: number, types: Reduction['types']): StoredEvent[] {
  return db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id > ? AND id <= ? AND legacy = 0 AND type IN (${types.map(() => '?').join(', ')}) ORDER BY id LIMIT ?`)
    .all(from, through, ...types, REDUCE_BATCH) as unknown as StoredEvent[]
}

function batchThrough(events: StoredEvent[], from: number, target: number): number {
  return events.length < REDUCE_BATCH ? Math.max(from, target) : events.at(-1)!.id
}

function markInOrderThrough(db: DatabaseSync, through: number, incremental: Reduction['incremental']): void {
  db.exec(`PRAGMA user_version = ${through}`)
  markReduced(db, SNAPSHOT, through)
  for (const projection of REDUCED_IN_ORDER)
    markReduced(db, projection, through)
  for (const projection of incremental) {
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

function publishTheShadows(db: DatabaseSync, through: number, incremental: Reduction['incremental']): void {
  for (const table of PROJECTION_TABLES)
    db.exec(`DELETE FROM main.${table}; INSERT INTO main.${table} SELECT * FROM temp.${table};`)
  copySequences(db, 'temp.sqlite_sequence', 'main.sqlite_sequence')
  dropShadows(db)
  takeWholeSnapshot(db)
  trackDirtyRows(db)
  markInOrderThrough(db, through, incremental)
}

function buildBesideTheLiveProjections(db: DatabaseSync, target: number, count: ReduceCount, reduction: Reduction): void {
  shadowTheProjections(db)
  try {
    let from = 0
    while (from < target) {
      from = inTransaction(db, () => {
        const events = eventsAfter(db, from, target, reduction.types)
        foldInOrder(db, events, count, reduction.folds)
        return batchThrough(events, from, target)
      })
    }
    inTransaction(db, () => publishTheShadows(db, target, reduction.incremental))
  }
  finally {
    dropShadows(db)
  }
}

function reduceBatch(db: DatabaseSync, target: number, count: ReduceCount, reduction: Reduction): boolean {
  return inTransaction(db, () => {
    const from = reducedThrough(db)
    if (from >= target)
      return false
    const events = eventsAfter(db, from, target, reduction.types)
    const through = batchThrough(events, from, target)
    restoreDirtyRows(db)
    foldInOrder(db, events, count, reduction.folds)
    snapshotDirtyRows(db)
    markInOrderThrough(db, through, reduction.incremental)
    return through < target
  })
}

export function reduce(db: DatabaseSync, scope: ReduceScope, projections: Projections): ReduceCount {
  const count: ReduceCount = { applied: 0, rejected: 0 }
  const reduction = reductionOf(projections)
  markTheDecisionsCutOver(db, new Date().toISOString())
  const target = lastEventId(db)
  if (scope === 'rebuild' || !snapshotHolds(db))
    buildBesideTheLiveProjections(db, target, count, reduction)
  let another = true
  while (another)
    another = reduceBatch(db, target, count, reduction)
  return count
}

export function projectionDump(db: DatabaseSync): string {
  return JSON.stringify(Object.fromEntries(Object.entries(PROJECTION_KEYS).map(([table, key]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()])))
}

function main(): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    const count = reduce(db, 'rebuild', busProjections())
    console.log(`${PREFIX}${busPath}: applied ${count.applied}, rejected ${count.rejected}`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
