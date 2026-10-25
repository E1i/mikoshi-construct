import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_STARTED } from '../../core/events.js'
import { windowOpenPrs } from '../../window/window-prs.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-window-prs-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function started(db: DatabaseSync, cardId: number, actor: string, payload: Record<string, unknown> = {}): number {
  appendEvent(db, { ts: '2026-10-19T10:00:00.000Z', type: CARD_STARTED, actor, cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}:${actor}`, payload: { path: 'cheap', ...payload }, legacy: false })
  return (db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id
}

function pr(db: DatabaseSync, number: number, cardId: number | null, state: string, ci: string, eventId: number): void {
  db.prepare('INSERT INTO prs (pr, card_id, head, state, ci, event_id) VALUES (?, ?, ?, ?, ?, ?)').run(number, cardId, `h${number}`, state, ci, eventId)
}

describe('the open pull requests of the window', () => {
  it('are the open ones whose card the window started by task:start, not a shift, a closed one or one with no card, each with its card body priority', () => {
    const db = newBus()
    pr(db, 901, 1, 'open', 'red', started(db, 1, 'worker:start:s1'))
    pr(db, 902, 2, 'open', 'green', started(db, 2, 'worker:start:s1', { shift: 'shift-1' }))
    pr(db, 903, 3, 'closed', 'green', started(db, 3, 'worker:start:by-hand'))
    pr(db, 904, null, 'open', 'green', started(db, 4, 'worker:start:s1'))
    pr(db, 905, 5, 'open', 'pending', started(db, 5, 'worker:launch:s2'))
    const sixStarted = started(db, 6, 'worker:start:by-hand')
    pr(db, 906, 6, 'open', 'pending', sixStarted)
    db.prepare('INSERT OR REPLACE INTO cards (card_id, state, pr, event_id) VALUES (?, ?, ?, ?)').run(6, 'stopped', 906, sixStarted)
    db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, priority, lane) VALUES (?, ?, ?, ?, ?, ?)').run(1, sixStarted, 'card: #1', 'sha-1', 'p0', 'lane-1')

    expect(windowOpenPrs(db)).toEqual([
      { pr: 901, cardId: 1, head: 'h901', ci: 'red', cardState: null, priority: 'p0' },
      { pr: 906, cardId: 6, head: 'h906', ci: 'pending', cardState: 'stopped', priority: null },
    ])
  })
})
