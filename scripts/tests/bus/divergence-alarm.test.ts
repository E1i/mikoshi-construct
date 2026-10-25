import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { FOREIGN_DIVERGENCE, recordForeignDivergences } from '../../nodes/review/divergence-alarm.js'
import { BOARD_ALARM, BOARD_ALARM_CLEARED } from '../../core/events.js'

const ACTOR = 'worker:review:node-1'
const TS = '2026-10-20T11:00:00.000Z'

function details(db: DatabaseSync, type: string): string[] {
  return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type).map((row) => {
    const payload = JSON.parse(String(row.payload)) as { detail?: string, alarm?: string }
    return String(payload.detail ?? payload.alarm)
  })
}

describe('foreign divergence alarms', () => {
  it('each divergence holds its own alarm, and only the one that is gone is cleared', () => {
    const db = openBus(':memory:')
    recordForeignDivergences(db, ACTOR, TS, ['replay byte-diff: roles window: live only', 'replay byte-diff: decisions D-1: replay only'])
    expect(details(db, BOARD_ALARM)).toEqual(['replay byte-diff: roles window: live only', 'replay byte-diff: decisions D-1: replay only'])

    recordForeignDivergences(db, ACTOR, TS, ['replay byte-diff: decisions D-1: replay only'])
    const cleared = details(db, BOARD_ALARM_CLEARED)
    expect(cleared).toHaveLength(1)
    expect(cleared[0]!.startsWith(`${BOARD_ALARM}:${FOREIGN_DIVERGENCE}:`)).toBe(true)

    recordForeignDivergences(db, ACTOR, TS, [])
    expect(details(db, BOARD_ALARM_CLEARED)).toHaveLength(2)
    expect(details(db, BOARD_ALARM)).toHaveLength(2)
    db.close()
  })
})
