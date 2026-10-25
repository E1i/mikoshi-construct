import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { replayDifferences } from '../../core/report.js'

const TS = '2026-10-11T12:00:00.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-replay-snapshot-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function isEventRead(sql: string): boolean {
  return /^SELECT id, ts, type\b.* FROM events ORDER BY id$/.test(sql)
}

function appendingBeforeEventRead(db: DatabaseSync, append: () => void): DatabaseSync {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (isEventRead(sql))
            append()
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function enqueuedCount(db: DatabaseSync): number {
  return Number((db.prepare(`SELECT count(*) AS n FROM tasks WHERE card_id = 857`).get() as { n: number }).n)
}

describe('replayDifferences reads one snapshot of bus.db', () => {
  it('an event another connection appends between the dump read and the event read shows no difference', () => {
    const file = busFile()
    const db = openBus(file)
    const writer = openBus(file)
    try {
      queueTask(db, TS, { queue: 'answer', cardId: 856 })
      reduce(db)
      const interleaved = appendingBeforeEventRead(db, () => queueTask(writer, TS, { queue: 'answer', cardId: 857 }))

      expect(replayDifferences(interleaved).differences).toEqual([])
      expect(enqueuedCount(db)).toBe(1)
    }
    finally {
      writer.close()
      db.close()
    }
  })
})
