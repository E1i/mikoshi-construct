import type { DatabaseSync } from 'node:sqlite'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseCard } from '../../src/card/grammar.js'
import { OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED } from './events.js'
import { isActor, isFullSha, prOf } from './identifiers.js'
import { openDatabase } from './sqlite.js'

export { BUS_DB_VARIABLE, defaultBusPath } from './bus-path.js'
export const BUSY_TIMEOUT_MS = 30_000
export const CARD_BLOCKS = 'card_blocks'

const IN_MEMORY = ':memory:'

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
CREATE TABLE IF NOT EXISTS owner_waits (
  id TEXT PRIMARY KEY,
  need TEXT NOT NULL,
  text TEXT NOT NULL,
  command TEXT,
  card_id INTEGER,
  pr INTEGER,
  state TEXT NOT NULL,
  answer TEXT,
  opened_at TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  plan_file TEXT NOT NULL,
  state TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS plan_items (
  plan_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cards TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id),
  PRIMARY KEY (plan_id, item_id)
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
  const db = openDatabase(file, { timeout: BUSY_TIMEOUT_MS })
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`)
  db.exec(SCHEMA)
  addMissingColumns(db)
  db.function(CARD_BLOCKS, { deterministic: true }, blocksOfCardLine)
  if (file !== IN_MEMORY)
    watchLocks(db, { now: () => performance.now(), observe: lockLogger(locksLogOf(file)) })
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

export const OWNER_WAITS = 'owner_waits'
export const OWNER_WAIT_NEEDS = ['decision', 'merge', 'command'] as const
export const OPEN_WAIT = 'open'
export const CLOSED_WAIT = 'closed'
export const WAIT_ID = /^Q(\d+)$/

export type OwnerWaitNeed = typeof OWNER_WAIT_NEEDS[number]

export interface OwnerWaitAsk {
  need: OwnerWaitNeed
  text: string
  command?: string
  card?: number
  pr?: number
  request?: number
}

export function isOwnerWaitNeed(value: unknown): value is OwnerWaitNeed {
  return typeof value === 'string' && (OWNER_WAIT_NEEDS as readonly string[]).includes(value)
}

const UNCLOSED_WAIT_OF = `
  SELECT json_extract(opened.payload, '$.id') AS id FROM events AS opened
  WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.legacy = 0
    AND json_extract(opened.payload, '$.need') = ? AND json_extract(opened.payload, '$.command') IS ? AND json_extract(opened.payload, '$.pr') IS ?
    AND NOT EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS wait WHERE wait.id = json_extract(opened.payload, '$.id') AND wait.state = '${CLOSED_WAIT}')
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND json_extract(closed.payload, '$.id') = json_extract(opened.payload, '$.id'))
  ORDER BY opened.id LIMIT 1
`

function nextWaitId(db: DatabaseSync): string {
  const ids = db.prepare(`SELECT json_extract(payload, '$.id') AS id FROM events WHERE type = '${OWNER_WAIT_OPENED}'`).all() as { id: unknown }[]
  const numbers = ids.map(row => WAIT_ID.exec(typeof row.id === 'string' ? row.id : '')?.[1]).filter(found => found !== undefined).map(Number)
  return `Q${Math.max(0, ...numbers) + 1}`
}

export function openOwnerWait(db: DatabaseSync, ts: string, actor: string, ask: OwnerWaitAsk): string {
  const id = nextWaitId(db)
  const { need, text, ...named } = ask
  appendEvent(db, { ts, type: OWNER_WAIT_OPENED, actor, cardId: ask.card ?? null, pr: ask.pr ?? null, head: null, dedupeKey: `${OWNER_WAIT_OPENED}:${id}`, payload: { id, need, text, ...named }, legacy: false })
  return id
}

export function openBusWait(db: DatabaseSync, ts: string, actor: string, ask: OwnerWaitAsk): string {
  const open = db.prepare(UNCLOSED_WAIT_OF).get(ask.need, ask.command ?? null, ask.pr ?? null) as { id: string } | undefined
  return open?.id ?? openOwnerWait(db, ts, actor, ask)
}

export function closeOwnerWait(db: DatabaseSync, ts: string, actor: string, id: string, answer: string, request: number): boolean {
  return appendEvent(db, { ts, type: OWNER_WAIT_CLOSED, actor, cardId: null, pr: null, head: null, dedupeKey: `${OWNER_WAIT_CLOSED}:${id}`, payload: { id, answer, request }, legacy: false })
}

export const LOCKS_LOG = 'locks.log'
export const LOGGED_HOLD_MS = 2_000
export const LOGGED_WAIT_MS = 5_000

export type LockOutcome = 'commit' | 'rollback' | 'not-taken'

export interface LockReading {
  caller: () => string
  waitMs: number
  holdMs: number | null
  outcome: LockOutcome
}

export interface LockWatch {
  now: () => number
  observe: (reading: LockReading) => void
}

export interface LockHolder {
  pid: number
  argv: readonly string[]
}

const UNWATCHED: LockWatch = { now: () => 0, observe: () => {} }
const watches = new WeakMap<DatabaseSync, LockWatch>()

export function watchLocks(db: DatabaseSync, watch: LockWatch): void {
  watches.set(db, watch)
}

export function locksLogOf(busFile: string): string {
  return path.join(path.dirname(busFile), 'bus', LOCKS_LOG)
}

function callerOf(site: Error): string {
  const frame = site.stack?.split('\n')[2]?.trim() ?? ''
  return frame.startsWith('at ') ? frame.slice(3) : frame
}

function lockLine(holder: LockHolder, reading: LockReading, what: 'wait' | 'hold', ms: number): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), pid: holder.pid, argv: holder.argv.join(' '), caller: reading.caller(), what, ms: Math.round(ms), outcome: reading.outcome })}\n`
}

export function lockLogger(file: string, holder: LockHolder = { pid: process.pid, argv: process.argv }): (reading: LockReading) => void {
  return (reading) => {
    const lines = [
      ...(reading.waitMs > LOGGED_WAIT_MS ? [lockLine(holder, reading, 'wait', reading.waitMs)] : []),
      ...(reading.holdMs !== null && reading.holdMs > LOGGED_HOLD_MS ? [lockLine(holder, reading, 'hold', reading.holdMs)] : []),
    ]
    if (lines.length === 0)
      return
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, lines.join(''))
    }
    catch (error) {
      console.error(`the ${LOCKS_LOG} line was not written: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  const site = new Error('lock site')
  const watch = watches.get(db) ?? UNWATCHED
  const caller = (): string => callerOf(site)
  const asked = watch.now()
  try {
    db.exec('BEGIN IMMEDIATE')
  }
  catch (error) {
    watch.observe({ caller, waitMs: watch.now() - asked, holdMs: null, outcome: 'not-taken' })
    throw error
  }
  const taken = watch.now()
  const settled = (outcome: LockOutcome): void => watch.observe({ caller, waitMs: taken - asked, holdMs: watch.now() - taken, outcome })
  try {
    const result = work()
    db.exec('COMMIT')
    settled('commit')
    return result
  }
  catch (error) {
    db.exec('ROLLBACK')
    settled('rollback')
    throw error
  }
}
