import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HEARTBEATS, openBus } from '../../core/db.js'
import { PROCESS_HEARTBEAT } from '../../core/events.js'
import { recordProcessHeartbeat, RETIRED_FIELD, retirePreviousGeneration } from '../../supervisor/heartbeat.js'

const GENERATION_START = '2026-11-16T09:00:00.000Z'
const JUST_BEFORE_START = '2026-11-16T08:59:59.999Z'
const RETIRED_AT = '2026-11-16T09:00:05.000Z'
const BEAT_AT_START = 'miko:17686'
const BEAT_BEFORE_START = 'miko:17687'
const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'retire-generation-bound-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  return db
}

function retiredMark(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`SELECT payload FROM ${HEARTBEATS} WHERE process = ? AND type = ?`).get(name, PROCESS_HEARTBEAT) as { payload: string }
  return (JSON.parse(row.payload) as Record<string, unknown>)[RETIRED_FIELD]
}

function restartWithEveryPidGone(db: DatabaseSync): string[] {
  return retirePreviousGeneration(db, GENERATION_START, RETIRED_AT, () => true)
}

describe('the generation start bounds the previous generation exclusively', () => {
  it('keeps a row whose beat equals the generation start exactly, even when its pid is gone', () => {
    const db = bus()
    recordProcessHeartbeat(db, GENERATION_START, BEAT_AT_START)
    expect(restartWithEveryPidGone(db)).toEqual([])
    expect(retiredMark(db, BEAT_AT_START)).toBeUndefined()
  })

  it('retires a row one millisecond before the generation start and keeps the one at it', () => {
    const db = bus()
    recordProcessHeartbeat(db, GENERATION_START, BEAT_AT_START)
    recordProcessHeartbeat(db, JUST_BEFORE_START, BEAT_BEFORE_START)
    expect(restartWithEveryPidGone(db)).toEqual([BEAT_BEFORE_START])
    expect(retiredMark(db, BEAT_BEFORE_START)).toBe(RETIRED_AT)
    expect(retiredMark(db, BEAT_AT_START)).toBeUndefined()
  })
})
