import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { LEASE_MS } from '../../bus/lease.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import * as restartExecutor from '../../bus/restart-executor.js'
import * as restartWorker from '../../bus/restart-worker.js'
import * as role from '../../bus/role.js'
import { requestFromWindow } from '../../bus/window-requests.js'
import { CARD_STOPPED, ROLE_LEASED, ROLE_RAISED } from '../../core/events.js'

const MIKO_HANDOFF = '/handoff/miko.md'
const START = Date.parse('2026-10-22T10:00:00.000Z')
const RAISE_EVENTS = [ROLE_LEASED, ROLE_RAISED, role.ROLE_RAISE_FAILED, CARD_STOPPED]

function roleBus() {
  const root = mkdtempSync(path.join(tmpdir(), 'role-wait-'))
  const db = openBus(path.join(root, 'bus.db'))
  let now = START
  const worker = new restartWorker.RestartWorker({
    db,
    processes: { commandLine: () => null, signalGroup: () => {} },
    launchSwitchedOn: () => false,
    clock: () => new Date(now),
    session: 'worker-1',
  })
  return {
    db,
    worker,
    at: (): string => new Date(now).toISOString(),
    advance: (ms: number): void => {
      now += ms
    },
    stopMiko: (): void => {
      role.observeRoleStop(db, new Date(now).toISOString(), 'worker:miko:7', { role: 'miko', handoff: MIKO_HANDOFF, status: 'CONTINUE', reason: 'context', raised: false })
    },
    close: (): void => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function countOf(db: DatabaseSync, types: string[]): number {
  return (db.prepare(`SELECT count(*) AS n FROM events WHERE type IN (${types.map(() => '?').join(', ')})`).get(...types) as { n: number }).n
}

function waits(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT id, need, command, state FROM owner_waits ORDER BY id').all()
}

describe('a role stopped at a threshold', () => {
  it('an owner question is a wait in the bus and nothing is raised into the handoff', () => {
    const bus = roleBus()
    bus.stopMiko()

    const step = bus.worker.step()
    expect(step).toMatchObject({ kind: 'to_owner', role: 'miko', handoff: MIKO_HANDOFF, wait: 'Q1' })
    expect(restartWorker.restartStepLine(step)).toContain('as owner wait Q1')
    expect(bus.worker.step()).toEqual({ kind: 'idle' })
    reduce(bus.db)
    expect(waits(bus.db)).toEqual([{ id: 'Q1', need: 'command', command: 'pnpm miko', state: 'open' }])
    expect(countOf(bus.db, RAISE_EVENTS)).toBe(0)
    expect(bus.db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'reducer.rejected'`).get()).toEqual({ n: 0 })
    const live = projectionDump(bus.db)
    reduce(bus.db)
    expect(projectionDump(bus.db)).toBe(live)
    bus.close()
  })

  it('no raise into handoff/miko.md is left in the bus', () => {
    for (const raise of ['leaseRole', 'raiseRole', 'failRaise', 'assertRoleHeld', 'RAISES_PER_HANDOFF'])
      expect(Object.keys(role)).not.toContain(raise)
    expect(Object.keys(restartWorker)).not.toContain('roleLauncher')
    expect(Object.getOwnPropertyNames(restartExecutor.RestartExecutor.prototype)).not.toContain('relaunch')

    const bus = roleBus()
    bus.stopMiko()
    expect(bus.worker.step()).toMatchObject({ kind: 'to_owner', wait: 'Q1' })
    requestFromWindow(bus.db, bus.at(), 'owner-session', { kind: 'status' })
    bus.advance(LEASE_MS + 1)
    expect(bus.worker.step()).toMatchObject({ kind: 'returned', role: 'miko' })
    expect(bus.worker.step()).toMatchObject({ kind: 'to_owner', role: 'miko', wait: 'Q1' })
    for (let tick = 0; tick < 5; tick += 1) {
      bus.advance(LEASE_MS + 1)
      bus.worker.step()
    }
    reduce(bus.db)
    expect(countOf(bus.db, RAISE_EVENTS)).toBe(0)
    expect(waits(bus.db)).toEqual([{ id: 'Q1', need: 'command', command: 'pnpm miko', state: 'open' }])
    bus.close()
  })

  it('a stopped Operator goes to the owner with no wait, since the bus names no action for it', () => {
    const bus = roleBus()
    role.observeRoleStop(bus.db, bus.at(), 'worker:operator:7', { role: 'operator', handoff: '/handoff/operator.md', status: 'CONTINUE', reason: 'spend', raised: false })

    const step = bus.worker.step()
    expect(step).toMatchObject({ kind: 'to_owner', role: 'operator', wait: null })
    expect(restartWorker.restartStepLine(step)).toContain('with no wait')
    reduce(bus.db)
    expect(waits(bus.db)).toEqual([])
    expect(countOf(bus.db, RAISE_EVENTS)).toBe(0)
    bus.close()
  })
})
