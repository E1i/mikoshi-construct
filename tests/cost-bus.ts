import process from 'node:process'

export interface BusCard {
  id: number
  line: string | null
  started: string
  ended: string
  start?: Record<string, unknown>
  close?: Record<string, unknown>
  legacy?: number
  restart?: { started: string, start: Record<string, unknown> }
  answered?: { ts: string, answer: Record<string, unknown> }
}

const CHEAP_LINE = (id: number): string => `#${id} cost-bus [implement/eddies/M/cheap/owner] · depends — · blocks —`

export function busCard(id: number, fields: Partial<BusCard> = {}): BusCard {
  return { id, line: CHEAP_LINE(id), started: '2026-10-14T00:00:00.000Z', ended: '2026-10-14T00:06:00.000Z', start: { session: `s${id}`, worktree: `/work/mc-${id}`, branch: 'b' }, close: { verification: 'run' }, ...fields }
}

export function writeBus(file: string, cards: BusCard[]): void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT NOT NULL, card_id INTEGER, legacy INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
    CREATE TABLE cards (card_id INTEGER PRIMARY KEY, state TEXT);
    CREATE TABLE card_bodies (card_id INTEGER PRIMARY KEY, card_line TEXT);
  `)
  for (const card of cards) {
    db.prepare('INSERT INTO cards (card_id, state) VALUES (?, ?)').run(card.id, 'closed')
    db.prepare('INSERT INTO card_bodies (card_id, card_line) VALUES (?, ?)').run(card.id, card.line)
    db.prepare('INSERT INTO events (ts, type, card_id, legacy, payload) VALUES (?, ?, ?, ?, ?)').run(card.started, 'card.started', card.id, card.legacy ?? 0, JSON.stringify(card.start ?? {}))
    if (card.restart)
      db.prepare('INSERT INTO events (ts, type, card_id, payload) VALUES (?, ?, ?, ?)').run(card.restart.started, 'card.started', card.id, JSON.stringify(card.restart.start))
    if (card.answered)
      db.prepare('INSERT INTO events (ts, type, card_id, payload) VALUES (?, ?, ?, ?)').run(card.answered.ts, 'card.answered', card.id, JSON.stringify(card.answered.answer))
    db.prepare('INSERT INTO events (ts, type, card_id, payload) VALUES (?, ?, ?, ?)').run(card.ended, 'card.closed', card.id, JSON.stringify(card.close ?? {}))
  }
  db.close()
}

export function writeLegacy(file: string, lines: unknown[]): void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(file)
  for (const line of lines) {
    const event = typeof line === 'object' && line !== null && 'event' in line ? String(line.event) : 'unreadable'
    db.prepare('INSERT INTO events (type, legacy, payload) VALUES (?, 1, ?)').run(event, typeof line === 'string' ? line : JSON.stringify(line))
  }
  db.close()
}
