import type { BusEvent } from '../../bus/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { cardIdOf, isActor, taskKey } from '../../bus/identifiers.js'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): ReturnType<typeof openBus> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-db-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function observed(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    ts: '2026-10-09T12:00:00.000Z',
    type: 'pr.observed',
    actor: 'netwatch',
    cardId: 792,
    pr: 800,
    head: HEAD,
    dedupeKey: 'pr:800:abc',
    payload: { base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false },
    legacy: false,
    ...overrides,
  }
}

describe('bus.db', () => {
  it('opens in WAL mode with the five tables of the contract', () => {
    const db = newBus()
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(row => row.name)
    expect(tables).toEqual(['cards', 'decisions', 'events', 'prs', 'tasks'])
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
    expect(taskColumns).toContain('lease_gen')
    db.close()
  })

  it('a second event with the same dedupe_key is not inserted', () => {
    const db = newBus()
    expect(appendEvent(db, observed())).toBe(true)
    expect(appendEvent(db, observed({ ts: '2026-10-09T12:01:00.000Z' }))).toBe(false)
    expect(appendEvent(db, observed({ dedupeKey: 'pr:800:def' }))).toBe(true)
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 2 })
    db.close()
  })

  it('keeps events append-only: an update or a delete is refused', () => {
    const db = newBus()
    appendEvent(db, observed())
    expect(() => db.exec(`UPDATE events SET type = 'x'`)).toThrow(/append-only/)
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/)
    db.close()
  })

  it('refuses an event outside the actor enum, a partial head or a non-integer pr', () => {
    const db = newBus()
    expect(() => appendEvent(db, observed({ actor: 'window' }))).toThrow(/actor/)
    expect(() => appendEvent(db, observed({ head: 'abc123' }))).toThrow(/full sha/)
    expect(() => appendEvent(db, observed({ pr: 1.5 }))).toThrow(/pr/)
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 })
    db.close()
  })

  it('enforces task_key UNIQUE in tasks', () => {
    const db = newBus()
    appendEvent(db, observed())
    const insert = db.prepare(`INSERT INTO tasks (task_key, queue, card_id, state, event_id) VALUES (?, 'review', 792, 'queued', 1)`)
    insert.run('review:792:800:-')
    expect(() => insert.run('review:792:800:-')).toThrow(/UNIQUE/)
    db.close()
  })
})

describe('identifiers', () => {
  it('task_key is <queue>:<card_id>:<pr|->:<head|->', () => {
    expect(taskKey({ queue: 'review', cardId: 792, pr: 800, head: HEAD })).toBe(`review:792:800:${HEAD}`)
    expect(taskKey({ queue: 'launch', cardId: 792 })).toBe('launch:792:-:-')
    expect(taskKey({ queue: 'update', cardId: 792, pr: 800 })).toBe('update:792:800:-')
    expect(() => taskKey({ queue: 'review', cardId: 792, pr: 800, head: 'abc123' })).toThrow(/full sha/)
    expect(() => taskKey({ queue: 'review', cardId: 0 })).toThrow(/card_id/)
  })

  it('reads a card id from a number, a numeric string, a card line or an object, and nothing from a bare slug', () => {
    expect(cardIdOf(656)).toBe(656)
    expect(cardIdOf('656')).toBe(656)
    expect(cardIdOf('#753 owner-merges-narrows [implement/runner/S/cheap/owner] · depends — · blocks —')).toBe(753)
    expect(cardIdOf({ id: 729, name: 'x' })).toBe(729)
    expect(cardIdOf('271-2')).toBe(271)
    expect(cardIdOf('shredder-collect')).toBeNull()
    expect(cardIdOf(null)).toBeNull()
  })

  it('accepts the actor enum and nothing else', () => {
    for (const actor of ['netwatch', 'reducer', 'owner', 'policy', 'worker:review:827aa1a1'])
      expect(isActor(actor)).toBe(true)
    for (const actor of ['window', 'worker:review', 'worker::s', ''])
      expect(isActor(actor)).toBe(false)
  })
})
