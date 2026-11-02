import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_FILE, snapshotPathOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { MERGE_DONE } from '../../core/events.js'
import { openDatabase } from '../../core/sqlite.js'
import { BusSnapshot, SNAPSHOT_MS } from '../../supervisor/bus-snapshot.js'

const START = Date.parse('2026-11-03T12:00:00.000Z')
const MINUTE = 60_000

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function append(db: DatabaseSync, type: string, key: string): void {
  appendEvent(db, { ts: new Date(START).toISOString(), type, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: key, payload: {}, legacy: false })
}

function snapshotEvents(file: string): number {
  const db = openDatabase(file, { readOnly: true })
  try {
    return Number((db.prepare('SELECT count(*) AS count FROM events').get() as { count: number }).count)
  }
  finally {
    db.close()
  }
}

describe('the bus snapshot for external readers', () => {
  it('the bus publishes a snapshot through the backup API on its timer and after a merge', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-bus-snapshot-'))
    roots.push(root)
    const busPath = path.join(root, BUS_FILE)
    const file = snapshotPathOf(busPath)
    const db = openBus(busPath)
    let now = START
    const snapshot = new BusSnapshot({ db, busPath, file, now: () => now })
    try {
      append(db, 'card.pulse', 'one')
      expect(snapshot.step()).toEqual([expect.stringContaining('on its timer')])
      expect(snapshotEvents(file)).toBe(1)

      append(db, 'card.pulse', 'two')
      now += MINUTE
      expect(snapshot.step()).toEqual([])
      expect(snapshotEvents(file)).toBe(1)

      append(db, MERGE_DONE, 'merged')
      now += MINUTE
      expect(snapshot.step()).toEqual([expect.stringContaining('after a merge')])
      expect(snapshotEvents(file)).toBe(3)

      append(db, 'card.pulse', 'three')
      now += SNAPSHOT_MS
      expect(snapshot.step()).toEqual([expect.stringContaining('on its timer')])
      expect(snapshotEvents(file)).toBe(4)
    }
    finally {
      db.close()
    }
  })

  it('a paused bus publishes nothing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-bus-snapshot-'))
    roots.push(root)
    const busPath = path.join(root, BUS_FILE)
    const db = openBus(busPath)
    try {
      expect(new BusSnapshot({ db, busPath, file: snapshotPathOf(busPath), now: () => START, paused: () => true }).step()).toEqual([])
    }
    finally {
      db.close()
    }
  })
})
