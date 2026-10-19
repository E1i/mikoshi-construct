import { DatabaseSync } from 'node:sqlite'

const BUS_SCHEMA = `
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT NOT NULL, card_id INTEGER, payload TEXT NOT NULL);
CREATE TABLE cards (card_id INTEGER PRIMARY KEY, state TEXT, pr INTEGER);
CREATE TABLE card_bodies (card_id INTEGER PRIMARY KEY, lane TEXT, card_line TEXT);
CREATE TABLE prs (pr INTEGER PRIMARY KEY, verdict_on_head TEXT);
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, card_id INTEGER NOT NULL, pr INTEGER, head TEXT, state TEXT NOT NULL);
`

export interface SeedCard {
  id: number
  state: string | null
  lane: string | null
  line: string | null
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
}

export interface BusSeed {
  cards?: SeedCard[]
  verdicts?: [number, string | null][]
  tasks?: SeedTask[]
  events?: SeedEvent[]
}

export function writeBus(file: string, seed: BusSeed): string {
  const db = new DatabaseSync(file)
  try {
    db.exec(BUS_SCHEMA)
    for (const card of seed.cards ?? []) {
      db.prepare('INSERT INTO cards (card_id, state, pr) VALUES (?, ?, NULL)').run(card.id, card.state)
      db.prepare('INSERT INTO card_bodies (card_id, lane, card_line) VALUES (?, ?, ?)').run(card.id, card.lane, card.line)
    }
    for (const [pr, verdict] of seed.verdicts ?? [])
      db.prepare('INSERT INTO prs (pr, verdict_on_head) VALUES (?, ?)').run(pr, verdict)
    for (const task of seed.tasks ?? [])
      db.prepare('INSERT INTO tasks (queue, card_id, pr, head, state) VALUES (?, ?, ?, ?, ?)').run(task.queue, task.card, task.pr, task.head, task.state)
    for (const event of seed.events ?? [])
      db.prepare('INSERT INTO events (ts, type, card_id, payload) VALUES (?, ?, ?, ?)').run(event.ts, event.type, event.card, event.payload)
  }
  finally {
    db.close()
  }
  return file
}

export function subagent(ts: string | null, payload: Record<string, unknown> | string): SeedEvent {
  return { ts, type: 'window.subagent', card: null, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}
