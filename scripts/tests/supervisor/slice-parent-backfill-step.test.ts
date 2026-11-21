import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from '../../core/stored.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendCardEvent, backfillSliceParents, foldCardBody, SLICE_PARENTS_BUS_ACTOR } from '../../core/card-bodies.js'
import { CARD_ADMITTED, SLICE_PARENTS_BACKFILLED } from '../../core/events.js'
import { deriveQueuesOfTheBus, openComposedBus, sliceParentsOnce } from '../../supervisor/composition.js'

const TS = '2026-11-17T09:00:00.000Z'
const LATER = '2026-11-17T10:00:00.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'slice-parent-backfill-step-'))
  roots.push(root)
  return openComposedBus(path.join(root, 'bus.db'))
}

function admitBeforeTheField(db: DatabaseSync, id: number, name: string): void {
  const text = `card: #${id} ${name} [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/${name}\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
  appendCardEvent(db, 'worker:intake:test', { type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `${CARD_ADMITTED}:${id}`, payload: { text, textSha: textSha(text) } })
  foldCardBody(db, db.prepare('SELECT * FROM events WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id) as unknown as StoredEvent)
}

function backfills(db: DatabaseSync): { actor: string, payload: string }[] {
  return db.prepare('SELECT actor, payload FROM events WHERE type = ?').all(SLICE_PARENTS_BACKFILLED) as { actor: string, payload: string }[]
}

describe('the bus runs the slice-parent backfill once', () => {
  it('a bus with slice cards and no slice.parents.backfilled event gets exactly one on the first run, and a second run writes nothing', () => {
    const db = bus()
    try {
      admitBeforeTheField(db, 60, 'shredded-slice-1')
      admitBeforeTheField(db, 61, 'shredded-slice-2')
      admitBeforeTheField(db, 80, 'whole-card')
      deriveQueuesOfTheBus(db, TS)
      const first = backfills(db)
      expect(first).toHaveLength(1)
      expect(first[0]!.actor).toBe(SLICE_PARENTS_BUS_ACTOR)
      expect(JSON.parse(first[0]!.payload)).toEqual({ cards: { 60: { card: 60, part: 1, of: 2 }, 61: { card: 60, part: 2, of: 2 } }, unread: [] })
      admitBeforeTheField(db, 62, 'later-slice-1')
      deriveQueuesOfTheBus(db, LATER)
      expect(backfills(db)).toEqual(first)
    }
    finally {
      db.close()
    }
  })

  it('the step skips outright once a slice.parents.backfilled event exists, whoever wrote it', () => {
    const db = bus()
    try {
      admitBeforeTheField(db, 60, 'shredded-slice-1')
      admitBeforeTheField(db, 61, 'shredded-slice-2')
      expect(backfillSliceParents(db, TS).recorded).toBe(true)
      admitBeforeTheField(db, 62, 'later-slice-1')
      expect(sliceParentsOnce(db, LATER)).toBeNull()
      expect(backfills(db)).toHaveLength(1)
    }
    finally {
      db.close()
    }
  })

  it('a bus whose cards carry no slice without a parent gets no event', () => {
    const db = bus()
    try {
      admitBeforeTheField(db, 80, 'whole-card')
      deriveQueuesOfTheBus(db, TS)
      expect(backfills(db)).toEqual([])
    }
    finally {
      db.close()
    }
  })
})
