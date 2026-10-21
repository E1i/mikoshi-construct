import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseCard } from '../../src/card/grammar.js'
import { isActor, isFullSha, prOf } from './identifiers.js'
import { openDatabase } from './sqlite.js'

export { BUS_DB_VARIABLE, defaultBusPath } from '../core/bus-path.js'
export const BUSY_TIMEOUT_MS = 30_000
export const CARD_BLOCKS = 'card_blocks'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  type TEXT NOT NULL,
  actor TEXT,
  card_id INTEGER,
  pr INTEGER,
  head TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  CHECK (legacy = 1 OR (actor IS NOT NULL AND ts IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS cards (
  card_id INTEGER PRIMARY KEY,
  state TEXT,
  pr INTEGER,
  event_id INTEGER NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS prs (
  pr INTEGER PRIMARY KEY,
  card_id INTEGER,
  base TEXT,
  head TEXT,
  state TEXT,
  mergeable TEXT,
  ci TEXT,
  verdict_on_head TEXT,
  auto_merge INTEGER,
  draft INTEGER,
  event_id INTEGER NOT NULL REFERENCES events(id),
  body_sha TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL UNIQUE,
  queue TEXT NOT NULL,
  card_id INTEGER NOT NULL,
  pr INTEGER,
  head TEXT,
  state TEXT NOT NULL,
  lease_gen INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  event_id INTEGER NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS mains (
  sha TEXT PRIMARY KEY,
  touches_mechanics INTEGER NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS chains (
  dir TEXT PRIMARY KEY,
  card_id INTEGER NOT NULL,
  parking TEXT NOT NULL,
  sha TEXT NOT NULL,
  pid INTEGER NOT NULL,
  leader INTEGER,
  boundary INTEGER NOT NULL,
  state TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS roles (
  role TEXT PRIMARY KEY,
  handoff TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_gen INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  pid INTEGER,
  raises INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  event_id INTEGER NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  scope TEXT,
  source TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS card_bodies (
  card_id INTEGER PRIMARY KEY,
  admission_event_id INTEGER NOT NULL REFERENCES events(id),
  text TEXT NOT NULL,
  text_sha TEXT NOT NULL,
  lane TEXT,
  who TEXT,
  priority TEXT,
  branch TEXT,
  touches TEXT,
  creates TEXT,
  card_line TEXT,
  contour TEXT,
  decision TEXT,
  depends TEXT
);
CREATE TABLE IF NOT EXISTS projection_watermarks (
  projection TEXT PRIMARY KEY,
  through_event_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_cursors (
  kind TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL
);
`

const ADDED_COLUMNS: readonly (readonly [string, string, string])[] = [['prs', 'body_sha', 'TEXT']]

function addMissingColumns(db: DatabaseSync): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!columns.some(each => each.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export interface BusEvent {
  ts: string | null
  type: string
  actor: string | null
  cardId: number | null
  pr: number | null
  head: string | null
  dedupeKey: string
  payload: unknown
  legacy: boolean
}

function blocksOfCardLine(line: unknown): string | null {
  if (typeof line !== 'string')
    return null
  const parsed = parseCard(line)
  return parsed.kind === 'card' ? JSON.stringify(parsed.card.blocks) : null
}

export function openBus(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = openDatabase(file)
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`)
  db.exec(SCHEMA)
  addMissingColumns(db)
  db.function(CARD_BLOCKS, { deterministic: true }, blocksOfCardLine)
  return db
}

function checked(event: BusEvent): BusEvent {
  if (event.type === '')
    throw new Error('an event needs a type')
  if (event.dedupeKey === '')
    throw new Error('an event needs a dedupe_key')
  if (!event.legacy && (event.actor === null || !isActor(event.actor)))
    throw new Error(`actor is not one of netwatch | reducer | worker:<kind>:<session> | owner | policy: ${event.actor}`)
  if (!event.legacy && event.ts === null)
    throw new Error('an event needs a ts')
  if (event.pr !== null && prOf(event.pr) === null)
    throw new Error(`pr is not a positive integer: ${event.pr}`)
  if (event.head !== null && !isFullSha(event.head))
    throw new Error(`head is not a full sha: ${event.head}`)
  return event
}

export function appendEvent(db: DatabaseSync, event: BusEvent): boolean {
  const valid = checked(event)
  const result = db.prepare(`
    INSERT INTO events (ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dedupe_key) DO NOTHING
  `).run(
    valid.ts,
    valid.type,
    valid.actor,
    valid.cardId,
    valid.pr,
    valid.head,
    valid.dedupeKey,
    typeof valid.payload === 'string' ? valid.payload : JSON.stringify(valid.payload),
    valid.legacy ? 1 : 0,
  )
  return Number(result.changes) === 1
}

export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
