import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from '../../core/stored.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { parentsFromCardLines } from '../../../src/commands/intake/slice.js'
import { appendCardEvent, backfillSliceParents, foldCardBody } from '../../core/card-bodies.js'
import { openBus } from '../../core/db.js'
import { CARD_ADMITTED, SLICE_PARENTS_BACKFILLED } from '../../core/events.js'
import { backfillLines, sliceParentBackfill } from '../../intake/slice-parent-backfill.js'

const TS = '2026-11-13T09:00:00.000Z'
const LATER = '2026-11-13T10:00:00.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'slice-parent-backfill-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function body(id: number, name: string, blocks = '—'): string {
  return `card: #${id} ${name} [implement/runner/S/cheap/owner] · depends — · blocks ${blocks}\nbranch: feat/${name}\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

function admit(db: DatabaseSync, id: number, name: string, parent?: Record<string, number>, blocks?: string): void {
  const text = body(id, name, blocks)
  appendCardEvent(db, 'worker:intake:test', { type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `${CARD_ADMITTED}:${id}`, payload: { text, textSha: textSha(text), ...(parent === undefined ? {} : { parent }) } })
  foldCardBody(db, db.prepare('SELECT * FROM events WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id) as unknown as StoredEvent)
}

function backfillEvents(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(SLICE_PARENTS_BACKFILLED) as { n: number }).n)
}

describe('cards cut before the parent field get it once from their card line', () => {
  it('transfers the parent and the share of each slice that has no field, and a second run writes nothing', () => {
    const file = busFile()
    const db = openBus(file)
    try {
      admit(db, 50, 'stub-card')
      admit(db, 51, 'stub-card-slice-1', undefined, '#50')
      admit(db, 52, 'stub-card-slice-2', undefined, '#50')
      admit(db, 60, 'shredded-slice-1')
      admit(db, 61, 'shredded-slice-2')
      admit(db, 62, 'shredded-slice-3')
      admit(db, 70, 'new-cut-slice-1', { card: 69, part: 1, of: 2 })
      admit(db, 80, 'whole-card')
    }
    finally {
      db.close()
    }
    const first = sliceParentBackfill(TS, file)
    expect(first.recorded).toBe(true)
    expect(first.transfer).toEqual({
      cards: {
        51: { card: 50, part: 1, of: 2 },
        52: { card: 50, part: 2, of: 2 },
        60: { card: 60, part: 1, of: 3 },
        61: { card: 60, part: 2, of: 3 },
        62: { card: 60, part: 3, of: 3 },
      },
      unread: [],
    })
    const second = sliceParentBackfill(LATER, file)
    expect(second.recorded).toBe(false)
    expect(second.transfer).toEqual(first.transfer)
    expect(backfillLines(second)[0]).toContain('already recorded, nothing written')
    const reread = openBus(file)
    try {
      expect(backfillEvents(reread)).toBe(1)
    }
    finally {
      reread.close()
    }
  })

  it('leaves a slice name two cuts share without a parent, and says so', () => {
    const db = openBus(busFile())
    try {
      admit(db, 90, 'twice-slice-1')
      admit(db, 91, 'twice-slice-1')
      admit(db, 92, 'twice-slice-2')
      const { transfer } = backfillSliceParents(db, TS, parentsFromCardLines)
      expect(transfer.unread).toEqual([90, 91])
      expect(transfer.cards).toEqual({ 92: { card: 90, part: 2, of: 2 } })
    }
    finally {
      db.close()
    }
  })
})
