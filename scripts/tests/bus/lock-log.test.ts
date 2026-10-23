import type { DatabaseSync } from 'node:sqlite'
import type { LockReading } from '../../bus/db.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { inTransaction, lockLogger, locksLogOf, openBus, watchLocks } from '../../bus/db.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-locks-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function scripted(...readings: number[]): () => number {
  return () => readings.shift() ?? 0
}

function lines(file: string): Record<string, unknown>[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function writeTheSlowRow(db: DatabaseSync): void {
  inTransaction(db, () => db.exec(`CREATE TABLE IF NOT EXISTS probe (id INTEGER)`))
}

function failTheSlowRow(db: DatabaseSync): void {
  inTransaction(db, () => {
    throw new Error('injected')
  })
}

describe('the bus lock log', () => {
  it('a hold longer than 2 s and a wait longer than 5 s each write their own locks.log line with pid and function', () => {
    const file = busFile()
    const db = openBus(file)
    const log = locksLogOf(file)
    watchLocks(db, { now: scripted(0, 6_000, 8_500), observe: lockLogger(log) })
    writeTheSlowRow(db)

    expect(log).toBe(path.join(path.dirname(file), 'bus', 'locks.log'))
    expect(lines(log).map(({ ts: _ts, caller, ...rest }) => ({ ...rest, named: String(caller).includes('writeTheSlowRow') }))).toEqual([
      { pid: process.pid, argv: process.argv.join(' '), what: 'wait', ms: 6_000, outcome: 'commit', named: true },
      { pid: process.pid, argv: process.argv.join(' '), what: 'hold', ms: 2_500, outcome: 'commit', named: true },
    ])
  })

  it('a rolled-back hold is logged with its outcome, and a short wait and hold write nothing', () => {
    const file = busFile()
    const db = openBus(file)
    const log = locksLogOf(file)
    watchLocks(db, { now: scripted(0, 4_000, 6_000), observe: lockLogger(log) })
    writeTheSlowRow(db)
    expect(lines(log)).toEqual([])

    watchLocks(db, { now: scripted(0, 10, 3_010), observe: lockLogger(log) })
    expect(() => failTheSlowRow(db)).toThrow('injected')
    expect(lines(log).map(({ what, ms, outcome, caller }) => ({ what, ms, outcome, named: String(caller).includes('failTheSlowRow') }))).toEqual([
      { what: 'hold', ms: 3_000, outcome: 'rollback', named: true },
    ])
  })

  it('a wait that never takes the lock is read as not-taken with no hold', () => {
    const file = busFile()
    const db = openBus(file)
    const other = openBus(file)
    other.exec('BEGIN IMMEDIATE')
    db.exec('PRAGMA busy_timeout = 10')
    const readings: LockReading[] = []
    watchLocks(db, { now: () => performance.now(), observe: reading => readings.push(reading) })
    expect(() => writeTheSlowRow(db)).toThrow(/database is locked/)
    other.exec('ROLLBACK')

    expect(readings.map(({ holdMs, outcome }) => ({ holdMs, outcome }))).toEqual([{ holdMs: null, outcome: 'not-taken' }])
  })
})
