import type { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_FILE, snapshotPathOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { MERGE_DONE } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { openDatabase } from '../../core/sqlite.js'
import { backupInto, BusSnapshot, publishSnapshot, SNAPSHOT_MS } from '../../supervisor/bus-snapshot.js'
import { busProjections } from '../../supervisor/composition.js'

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

async function published(snapshot: BusSnapshot): Promise<string[]> {
  const started = snapshot.step()
  await snapshot.settled()
  return [...started, ...snapshot.step()]
}

function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-bus-snapshot-'))
  roots.push(root)
  return root
}

function seededBus(root: string): string {
  const busPath = path.join(root, 'bus', BUS_FILE)
  mkdirSync(path.dirname(busPath), { recursive: true })
  const db = openBus(busPath)
  for (let index = 0; index < 60; index++)
    appendEvent(db, { ts: new Date(START).toISOString(), type: `kind${index % 5}`, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `seed:${index}`, payload: { index, text: 'x'.repeat(200) }, legacy: false })
  reduce(db, 'pending', busProjections())
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  return busPath
}

function breakEventsIndex(busPath: string): void {
  const db = openDatabase(busPath)
  const root = Number((db.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get('events_by_type') as { rootpage: number }).rootpage)
  const size = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
  db.close()
  const fd = openSync(busPath, 'r+')
  try {
    const page = Buffer.alloc(size)
    readSync(fd, page, 0, size, (root - 1) * size)
    for (let at = page.indexOf('kind1'); at !== -1; at = page.indexOf('kind1', at + 1))
      page.write('kindZ', at)
    writeSync(fd, page, 0, size, (root - 1) * size)
  }
  finally {
    closeSync(fd)
  }
}

describe('the bus snapshot for external readers', () => {
  it('the bus publishes a snapshot through the backup API on its timer and after a merge', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-bus-snapshot-'))
    roots.push(root)
    const busPath = path.join(root, BUS_FILE)
    const file = snapshotPathOf(busPath)
    const db = openBus(busPath)
    let now = START
    const snapshot = new BusSnapshot({ db, busPath, file, now: () => now })
    try {
      append(db, 'card.pulse', 'one')
      expect(await published(snapshot)).toEqual([expect.stringContaining('on its timer')])
      expect(snapshotEvents(file)).toBe(1)

      append(db, 'card.pulse', 'two')
      now += MINUTE
      expect(await published(snapshot)).toEqual([])
      expect(snapshotEvents(file)).toBe(1)

      append(db, MERGE_DONE, 'merged')
      now += MINUTE
      expect(await published(snapshot)).toEqual([expect.stringContaining('after a merge')])
      expect(snapshotEvents(file)).toBe(3)

      append(db, 'card.pulse', 'three')
      now += SNAPSHOT_MS
      expect(await published(snapshot)).toEqual([expect.stringContaining('on its timer')])
      expect(snapshotEvents(file)).toBe(4)
    }
    finally {
      db.close()
    }
  })

  it('a copy of a bus with a broken events index does not replace the last good snapshot', async () => {
    const busPath = seededBus(newRoot())
    const file = snapshotPathOf(busPath)
    await publishSnapshot(busPath, file)
    breakEventsIndex(busPath)

    await expect(publishSnapshot(busPath, file)).rejects.toThrow('the last good snapshot is kept')
    expect(snapshotEvents(file)).toBe(60)
  })

  it('a missing sqlite3 shell is named as the dependency of the backup', async () => {
    const busPath = seededBus(newRoot())

    await expect(backupInto(busPath, `${busPath}.copy`, 'sqlite3-not-installed')).rejects.toThrow('sqlite3-not-installed is not on PATH')
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
