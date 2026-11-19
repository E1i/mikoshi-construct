import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from './events.js'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busProjections } from '../supervisor/composition.js'
import { IN_ORDER_MARK, REDUCED_IN_ORDER } from './bus-readings.js'
import { appendEvent, defaultBusPath, inTransaction, openBus, OWNER_WAITS } from './db.js'
import { catalogued, DECISIONS_CUT_OVER } from './events.js'
import { appliedOrRejected } from './rejection.js'
import { STORED_COLUMNS } from './stored.js'
import { markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const PREFIX = '[bus:reduce] '
export const PROJECTION_KEYS: Readonly<Record<string, string>> = { prs: 'pr', cards: 'card_id', tasks: 'task_key', mains: 'sha', chains: 'dir', roles: 'role', decisions: 'decision_id', card_bodies: 'card_id', plans: 'plan_id', card_releases: 'card_id', plan_items: 'plan_id, item_id', [OWNER_WAITS]: 'id' }

export interface ReduceCount {
  applied: number
  rejected: number
}

function markTheDecisionsCutOver(db: DatabaseSync, ts: string): void {
  appendEvent(db, { ts, type: DECISIONS_CUT_OVER, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: DECISIONS_CUT_OVER, payload: {}, legacy: false })
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
