import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { LEASE_MS } from '../../bus/lease.js'
import { FAILURES_TO_STOP } from '../../bus/queue.js'
import { reduce, reducedThrough } from '../../bus/reducer.js'
import { FOLDED_ON_APPEND, replayDifferences } from '../../bus/report.js'
import { failRaise, leaseRole, observeRoleStop, raiseRole, returnEndedRole, returnSilentRole, ROLE_FOLDS, roleToOwner } from '../../bus/role.js'
import { watermarkOf } from '../../bus/watermark.js'
import { recordWindowHeartbeat } from '../../bus/window-heartbeat.js'
import { requestFromWindow } from '../../bus/window-requests.js'

const EVENT_COLUMNS = 'id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy'
const START = Date.parse('2026-10-20T10:00:00.000Z')
const at = (ms: number): string => new Date(START + ms).toISOString()
const ACTOR = 'worker:restart:w'

function stop(db: DatabaseSync, ms: number, role: 'miko' | 'operator', handoff: string): void {
  observeRoleStop(db, at(ms), `worker:${role}:7`, { role, handoff, status: 'CONTINUE', reason: 'context', raised: false })
}

function liveRoles(): DatabaseSync {
  const db = openBus(':memory:')
  stop(db, 0, 'miko', '/handoff/miko.md')
  reduce(db)
  for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
    failRaise(db, at(failure), leaseRole(db, at(failure), ACTOR)!, 'relaunch did not start')
  roleToOwner(db, at(10), ACTOR)
  requestFromWindow(db, at(20), 'owner-session', { kind: 'status' })
  recordWindowHeartbeat(db, at(30), 'owner-session')
  returnSilentRole(db, at(40 + LEASE_MS), ACTOR)
  stop(db, 50 + LEASE_MS, 'operator', '/handoff/operator.md')
  raiseRole(db, at(60 + LEASE_MS), leaseRole(db, at(60 + LEASE_MS), ACTOR)!, 4242)
  return db
}

function rolesOf(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT * FROM roles ORDER BY role').all()
}

describe('roles are a projection the reducer alone writes', () => {
  it('roles rebuilt by the reducer alone from a clean db equal the live roles at one watermark', () => {
    const live = liveRoles()
    const watermark = watermarkOf(live, 'roles')
    expect(watermark).toBeGreaterThan(reducedThrough(live))
    const clean = openBus(':memory:')
    const insert = clean.prepare(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of live.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id <= ? ORDER BY id`).all(watermark))
      insert.run(row.id, row.ts, row.type, row.actor, row.card_id, row.pr, row.head, row.dedupe_key, row.payload, row.legacy)
    reduce(clean)
    expect(clean.prepare(`SELECT count(*) AS n FROM events WHERE type = 'reducer.rejected' AND json_extract(payload, '$.type') LIKE 'role.%'`).get()).toEqual({ n: 0 })
    expect(rolesOf(clean)).toEqual(rolesOf(live))
    expect(rolesOf(live).map(row => (row as { state: string }).state)).toEqual(['raised', 'stopped'])
    clean.close()
    live.close()
  })

  it('the roles replay needs no fold-on-append compensation', () => {
    expect(Object.keys(ROLE_FOLDS).filter(type => FOLDED_ON_APPEND.has(type))).toEqual([])
    const db = liveRoles()
    expect(reducedThrough(db)).toBeLessThan(watermarkOf(db, 'roles'))
    expect(replayDifferences(db).differences).toEqual([])
    stop(db, 70 + LEASE_MS, 'miko', '/handoff/miko.md')
    returnEndedRole(db, at(80 + LEASE_MS), ACTOR, 'miko', 'close')
    stop(db, 90 + LEASE_MS, 'operator', '/handoff/operator.md')
    expect(replayDifferences(db).differences).toEqual([])
    reduce(db)
    expect(watermarkOf(db, 'roles')).toBe(reducedThrough(db))
    expect(replayDifferences(db).differences).toEqual([])
    db.close()
  })
})
