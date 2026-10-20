import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { LEASE_MS } from '../../bus/lease.js'
import { FAILURES_TO_STOP } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { failRaise, leaseRole, observeRoleStop, returnSilentRole, roleToOwner } from '../../bus/role.js'
import { requestFromWindow } from '../../bus/window-requests.js'
import { cloudOn } from '../../ghosts/cloud-key.js'
import { roleOutcome } from '../../ghosts/role.js'

describe('ghosts:role', () => {
  it('ghosts:role with CONSTRUCT_CLOUD unset launches the role locally, as today', () => {
    expect(roleOutcome(['review', '--task', 't1'], {})).toEqual({ code: 0, out: ['local: launch the review agent for t1'], err: [] })
    expect(roleOutcome(['scan', '--task', 't1'], { CONSTRUCT_CLOUD: 'off' }).out).toEqual(['local: launch the scan agent for t1'])
  })

  it('names the branch, the files and the acceptance when CONSTRUCT_CLOUD is 1', () => {
    const outcome = roleOutcome(['review', '--task', 't1'], { CONSTRUCT_CLOUD: '1' })
    expect(outcome.code).toBe(0)
    expect(outcome.out).toEqual(['cloud: review for t1 runs as a cloud session; it pushes role/t1-review with role/t1/review.md (and, for review, role/t1/review.verdict.json); accept with pnpm ghosts:verdict --from <ref> ...'])
  })

  it.each([
    { name: 'an unknown role', argv: ['plan', '--task', 't1'] },
    { name: 'a missing task', argv: ['brief'] },
    { name: 'an unknown option', argv: ['review', '--task', 't1', '--bogus'] },
  ])('prints usage on stderr and exits 1 for $name', ({ argv }) => {
    const outcome = roleOutcome(argv, {})
    expect(outcome.code).toBe(1)
    expect(outcome.out).toEqual([])
    expect(outcome.err[0]).toContain('usage: role.ts')
  })

  it('reads only the value 1 as cloud; 0, unset and anything else stay local', () => {
    expect([{ CONSTRUCT_CLOUD: '1' }, { CONSTRUCT_CLOUD: '0' }, { CONSTRUCT_CLOUD: 'on' }, {}].map(cloudOn)).toEqual([true, false, false, false])
  })
})

describe('the window role with the owner', () => {
  const HANDOFF = '/handoff/miko.md'
  const START = Date.parse('2026-10-20T10:00:00.000Z')
  const at = (ms: number): string => new Date(START + ms).toISOString()

  function ownerBus(): { db: DatabaseSync, close: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), 'role-owner-'))
    const db = openBus(path.join(root, 'bus.db'))
    observeRoleStop(db, at(0), 'worker:miko:7', { role: 'miko', handoff: HANDOFF, status: 'CONTINUE', reason: 'context', raised: false })
    reduce(db)
    for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
      failRaise(db, at(failure), leaseRole(db, at(failure), 'worker:restart:w')!, 'relaunch did not start')
    expect(roleToOwner(db, at(10), 'worker:restart:w')).toMatchObject({ role: 'miko' })
    return { db, close: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    } }
  }

  const roleRow = (db: DatabaseSync): unknown => db.prepare('SELECT state, raises, failures FROM roles WHERE role = ?').get('miko')

  it('an owner session that ended without miko:exit returns the role once its window is silent, and the bus raises it again', () => {
    const bus = ownerBus()
    requestFromWindow(bus.db, at(1000), 'owner-session', { kind: 'status' })
    expect(returnSilentRole(bus.db, at(1000 + LEASE_MS - 1), 'worker:restart:w')).toBeNull()

    expect(returnSilentRole(bus.db, at(1001 + LEASE_MS), 'worker:restart:w')).toEqual({ role: 'miko', handoff: HANDOFF, lastSign: at(1000) })
    expect(roleRow(bus.db)).toEqual({ state: 'stopped', raises: 0, failures: 0 })
    const live = projectionDump(bus.db)
    reduce(bus.db)
    expect(projectionDump(bus.db)).toBe(live)
    expect(leaseRole(bus.db, at(1002 + LEASE_MS), 'worker:restart:w')).toMatchObject({ role: 'miko', handoff: HANDOFF })
    bus.close()
  })

  it('a role with the owner stays there while no owner session has shown itself, or while its window is live', () => {
    const bus = ownerBus()
    expect(returnSilentRole(bus.db, at(10 * LEASE_MS), 'worker:restart:w')).toBeNull()
    requestFromWindow(bus.db, at(10 * LEASE_MS), 'owner-session', { kind: 'status' })
    requestFromWindow(bus.db, at(10.5 * LEASE_MS), 'owner-session', { kind: 'status' })
    expect(returnSilentRole(bus.db, at(11.2 * LEASE_MS), 'worker:restart:w')).toBeNull()
    expect(roleRow(bus.db)).toEqual({ state: 'owner', raises: 0, failures: FAILURES_TO_STOP })
    bus.close()
  })
})
