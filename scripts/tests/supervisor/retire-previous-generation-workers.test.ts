import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busPanelFacts } from '../../../src/commands/board/bus-panel.js'
import { HEARTBEATS, openBus, RETIRED_FIELD } from '../../core/db.js'
import { busPanelRow } from '../../core/events-query.js'
import { PROCESS_HEARTBEAT } from '../../core/events.js'
import { pidOfProcess, recordProcessHeartbeat, retiredRowsLines, retirePreviousGeneration } from '../../supervisor/heartbeat.js'

const OLD_BEAT = '2026-11-16T08:00:00.000Z'
const GENERATION_START = '2026-11-16T09:00:00.000Z'
const RETIRED_AT = '2026-11-16T09:00:05.000Z'
const FRESH_BEAT = '2026-11-16T09:01:00.000Z'
const NOW = new Date('2026-11-16T09:02:00.000Z')
const GONE_MIKO = 'miko:17686'
const LIVE_MIKO = 'miko:41180'
const NAMED_WORKER = 'bus:merge'
const LIVE_PIDS = new Set([41180])
const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'retire-generation-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  return db
}

function counted(db: DatabaseSync): string[] {
  const row = busPanelRow(db, { since: OLD_BEAT, mark: 'none', pulse: 'none', quiet: [], recent: 0, heartbeat: PROCESS_HEARTBEAT, alarm: 'none', cleared: 'none' })
  return busPanelFacts(row, NOW).workers.map(worker => worker.process)
}

function payloadOf(db: DatabaseSync, name: string): Record<string, unknown> {
  const row = db.prepare(`SELECT payload FROM ${HEARTBEATS} WHERE process = ? AND type = ?`).get(name, PROCESS_HEARTBEAT) as { payload: string }
  return JSON.parse(row.payload) as Record<string, unknown>
}

function restart(db: DatabaseSync): string[] {
  return retirePreviousGeneration(db, GENERATION_START, RETIRED_AT, pid => !LIVE_PIDS.has(pid))
}

describe('a supervisor start retires the heartbeat rows of its previous generation whose processes are gone', () => {
  it('after a restart a stale worker row of the old generation is not counted and is marked retired', () => {
    const db = bus()
    recordProcessHeartbeat(db, OLD_BEAT, GONE_MIKO)
    recordProcessHeartbeat(db, OLD_BEAT, LIVE_MIKO)
    recordProcessHeartbeat(db, OLD_BEAT, NAMED_WORKER)
    expect(counted(db)).toEqual([NAMED_WORKER, GONE_MIKO, LIVE_MIKO])

    expect(restart(db)).toEqual([GONE_MIKO])

    expect(counted(db)).toEqual([NAMED_WORKER, LIVE_MIKO])
    expect(payloadOf(db, GONE_MIKO)[RETIRED_FIELD]).toBe(RETIRED_AT)
    expect(db.prepare(`SELECT count(*) AS n FROM ${HEARTBEATS} WHERE process = ?`).get(GONE_MIKO)).toEqual({ n: 1 })
  })

  it('keeps a row of the current generation even when its pid is gone', () => {
    const db = bus()
    recordProcessHeartbeat(db, FRESH_BEAT, GONE_MIKO)
    expect(restart(db)).toEqual([])
    expect(counted(db)).toEqual([GONE_MIKO])
  })

  it('a fresh beat under a retired name counts again', () => {
    const db = bus()
    recordProcessHeartbeat(db, OLD_BEAT, GONE_MIKO)
    restart(db)
    recordProcessHeartbeat(db, FRESH_BEAT, GONE_MIKO)
    expect(counted(db)).toEqual([GONE_MIKO])
    expect(payloadOf(db, GONE_MIKO)[RETIRED_FIELD]).toBeUndefined()
  })

  it('retires a row once, and a second start reports nothing', () => {
    const db = bus()
    recordProcessHeartbeat(db, OLD_BEAT, GONE_MIKO)
    expect(restart(db)).toEqual([GONE_MIKO])
    expect(restart(db)).toEqual([])
  })

  it('reads a pid only from a trailing number of the process name', () => {
    expect(pidOfProcess(GONE_MIKO)).toBe(17686)
    expect(pidOfProcess(NAMED_WORKER)).toBeNull()
    expect(pidOfProcess('miko:0')).toBeNull()
  })

  it('names the retired rows in one line, and prints nothing when none was retired', () => {
    expect(retiredRowsLines('bus: ', [GONE_MIKO])).toEqual([expect.stringContaining(GONE_MIKO)])
    expect(retiredRowsLines('bus: ', [])).toEqual([])
  })
})
