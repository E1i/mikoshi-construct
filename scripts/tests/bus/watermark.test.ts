import type { DatabaseSync } from 'node:sqlite'
import type { IncrementalProjection } from '../../core/watermark.js'
import { describe, expect, it } from 'vitest'
import { appendEvent, inTransaction, openBus } from '../../core/db.js'
import { REJECTED } from '../../core/events.js'
import { reject } from '../../core/stored.js'
import { markReduced, reduceProjection, watermarkOf } from '../../core/watermark.js'

const AT = '2026-10-20T10:00:00.000Z'

const NOTES: IncrementalProjection = {
  table: 'mains',
  folds: {
    'note.kept': (db, event) => {
      db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, 0, ?)').run(event.dedupe_key, event.id)
    },
  },
}

function append(db: DatabaseSync, type: string, key: string): void {
  appendEvent(db, { ts: AT, type, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: key, payload: {}, legacy: false })
}

function kept(db: DatabaseSync): string[] {
  return (db.prepare('SELECT sha FROM mains ORDER BY event_id').all() as { sha: string }[]).map(row => row.sha)
}

describe('an incremental projection reduces from its own watermark', () => {
  it('applies only its own events past the watermark, once each, and moves the watermark to the last event', () => {
    const db = openBus(':memory:')
    append(db, 'note.kept', 'a')
    append(db, 'other.type', 'x')
    inTransaction(db, () => reduceProjection(db, NOTES))
    expect({ kept: kept(db), watermark: watermarkOf(db, 'mains') }).toEqual({ kept: ['a'], watermark: 2 })
    append(db, 'note.kept', 'b')
    inTransaction(db, () => reduceProjection(db, NOTES))
    inTransaction(db, () => reduceProjection(db, NOTES))
    expect({ kept: kept(db), watermark: watermarkOf(db, 'mains') }).toEqual({ kept: ['a', 'b'], watermark: 3 })
  })

  it('a watermark set by a full rebuild is where the next incremental reduce starts', () => {
    const db = openBus(':memory:')
    append(db, 'note.kept', 'a')
    markReduced(db, 'mains', 1)
    append(db, 'note.kept', 'b')
    inTransaction(db, () => reduceProjection(db, NOTES))
    expect(kept(db)).toEqual(['b'])
    expect(watermarkOf(db, 'roles')).toBe(0)
  })

  it('a rejected event is recorded, not thrown, and the watermark passes it as the full reduce does; any other error rolls the reduce back', () => {
    const db = openBus(':memory:')
    append(db, 'note.kept', 'a')
    append(db, 'note.kept', 'a-again')
    const picky: IncrementalProjection = { table: 'mains', folds: { 'note.kept': (inner, event) => event.dedupe_key === 'a' ? NOTES.folds['note.kept']!(inner, event) : reject('kept once') } }
    const broken: IncrementalProjection = { table: 'mains', folds: { 'note.kept': () => {
      throw new Error('disk full')
    } } }
    expect(() => inTransaction(db, () => reduceProjection(db, broken))).toThrow('disk full')
    expect({ kept: kept(db), watermark: watermarkOf(db, 'mains') }).toEqual({ kept: [], watermark: 0 })

    inTransaction(db, () => reduceProjection(db, picky))
    expect({ kept: kept(db), watermark: watermarkOf(db, 'mains') }).toEqual({ kept: ['a'], watermark: 2 })
    expect(db.prepare('SELECT json_extract(payload, \'$.reason\') AS reason FROM events WHERE type = ?').all(REJECTED)).toEqual([{ reason: 'kept once' }])
  })
})
