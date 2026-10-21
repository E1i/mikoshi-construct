import { DatabaseSync } from 'node:sqlite'

const BUS_SCHEMA = `
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT NOT NULL, card_id INTEGER, pr INTEGER, head TEXT, dedupe_key TEXT, legacy INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
CREATE TABLE cards (card_id INTEGER PRIMARY KEY, state TEXT, pr INTEGER, event_id INTEGER);
CREATE TABLE card_bodies (card_id INTEGER PRIMARY KEY, lane TEXT, card_line TEXT, text TEXT NOT NULL DEFAULT '');
CREATE TABLE prs (pr INTEGER PRIMARY KEY, card_id INTEGER, state TEXT, verdict_on_head TEXT);
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, card_id INTEGER NOT NULL, pr INTEGER, head TEXT, state TEXT NOT NULL);
CREATE TABLE roles (role TEXT PRIMARY KEY, status TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE decisions (decision_id INTEGER PRIMARY KEY, text TEXT NOT NULL, scope TEXT, event_id INTEGER);
`

const CARD_STATE_EVENT = 'card.state'
const DECISION_EVENT = 'decision.recorded'

export interface SeedCard {
  id: number
  state: string | null
  lane: string | null
  line: string | null
  text?: string
  body?: boolean
  since?: string | null
  pr?: number | null
}

export interface SeedTask {
  queue: string
  card: number
  pr: number | null
  head: string | null
  state: string
}

export interface SeedEvent {
  ts: string | null
  type: string
  card: number | null
  payload: string
  pr?: number | null
  head?: string | null
  dedupe?: string | null
  legacy?: boolean
}

export interface SeedRole {
  role: string
  status: string
  state: string
}

export interface SeedPr {
  pr: number
  card: number | null
  state: string
}

export interface BusSeed {
  cards?: SeedCard[]
  verdicts?: [number, string | null][]
  prs?: SeedPr[]
  tasks?: SeedTask[]
  events?: SeedEvent[]
  roles?: SeedRole[]
  decisions?: [number, string, number[]?][]
}

function insertEvent(db: DatabaseSync, event: SeedEvent): number {
  const result = db.prepare('INSERT INTO events (ts, type, card_id, pr, head, dedupe_key, legacy, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(event.ts, event.type, event.card, event.pr ?? null, event.head ?? null, event.dedupe ?? null, event.legacy === true ? 1 : 0, event.payload)
  return Number(result.lastInsertRowid)
}

export function writeBus(file: string, seed: BusSeed): string {
  const db = new DatabaseSync(file)
  try {
    db.exec(BUS_SCHEMA)
    for (const card of seed.cards ?? []) {
      const eventId = card.since === undefined ? null : insertEvent(db, { ts: card.since, type: CARD_STATE_EVENT, card: card.id, payload: '{}' })
      db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, ?, ?)').run(card.id, card.state, card.pr ?? null, eventId)
      if (card.body ?? true)
        db.prepare('INSERT INTO card_bodies (card_id, lane, card_line, text) VALUES (?, ?, ?, ?)').run(card.id, card.lane, card.line, card.text ?? '')
    }
    for (const [pr, verdict] of seed.verdicts ?? [])
      db.prepare('INSERT INTO prs (pr, verdict_on_head) VALUES (?, ?)').run(pr, verdict)
    for (const pr of seed.prs ?? [])
      db.prepare('INSERT INTO prs (pr, card_id, state) VALUES (?, ?, ?)').run(pr.pr, pr.card, pr.state)
    for (const task of seed.tasks ?? [])
      db.prepare('INSERT INTO tasks (queue, card_id, pr, head, state) VALUES (?, ?, ?, ?, ?)').run(task.queue, task.card, task.pr, task.head, task.state)
    for (const event of seed.events ?? [])
      insertEvent(db, event)
    for (const role of seed.roles ?? [])
      db.prepare('INSERT INTO roles (role, status, state) VALUES (?, ?, ?)').run(role.role, role.status, role.state)
    for (const [decisionId, text, scope] of seed.decisions ?? []) {
      const eventId = insertEvent(db, { ts: null, type: DECISION_EVENT, card: null, payload: '{}' })
      db.prepare('INSERT INTO decisions (decision_id, text, scope, event_id) VALUES (?, ?, ?, ?)').run(decisionId, text, scope === undefined ? null : JSON.stringify(scope), eventId)
    }
  }
  finally {
    db.close()
  }
  return file
}

export function subagent(ts: string | null, payload: Record<string, unknown> | string): SeedEvent {
  return { ts, type: 'window.subagent', card: null, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}

export function checkMatrix(pr: number | null, head: string | null, payload: Record<string, unknown> | string): SeedEvent {
  return { ts: null, type: 'checks.matrix', card: null, pr, head, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}
