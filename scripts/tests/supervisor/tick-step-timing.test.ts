import type { DatabaseSync } from 'node:sqlite'
import type { Poll } from '../../ports/netwatch.js'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { machineBusPath, snapshotPathOf } from '../../core/bus-path.js'
import { openBus } from '../../core/db.js'
import { decisionsInForceAt, withDecisionsHeldAt } from '../../policy/shards.js'
import { NetWatch } from '../../ports/netwatch.js'
import { LAST_STATUS_SET_ON_HEAD } from '../../ports/pr-status.js'
import { busPrFolds, deriveQueuesOfTheBus } from '../../supervisor/composition.js'
import { BusTick, TICK_STEPS, tickLines, tickOrLocked } from '../../supervisor/run.js'
import { Clock, FakeGitHub } from '../bus/github-fake.js'

const decisionReads = vi.hoisted(() => ({ count: 0 }))

vi.mock('../../policy/decisions/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../policy/decisions/index.js')>()
  return {
    ...real,
    inForceDecisions: (...args: Parameters<typeof real.inForceDecisions>) => {
      decisionReads.count++
      return real.inForceDecisions(...args)
    },
  }
})

const SNAPSHOT = process.env.TICK_SNAPSHOT ?? snapshotPathOf(machineBusPath(os.homedir()))
const DERIVE_BUDGET_MS = 2_000
const TICK_ROUNDS = 3
const STEP_MS = 7
const TS = '2026-11-17T00:00:00.000Z'

class NetWatchThatTicks extends NetWatch {
  override poll(): Poll {
    return { kind: 'ticked', reason: 'interval', calls: 0, remaining: null, written: 0, unsettled: [] }
  }
}

const buses: DatabaseSync[] = []
const dirs: string[] = []

afterEach(() => {
  for (const bus of buses.splice(0))
    bus.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function bus(file = ':memory:'): DatabaseSync {
  const db = openBus(file)
  buses.push(db)
  return db
}

function stepClock(): () => number {
  let now = 0
  return () => {
    now += STEP_MS
    return now
  }
}

function snapshotCopy(): DatabaseSync {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tick-step-timing-'))
  dirs.push(dir)
  const copy = path.join(dir, 'bus.db')
  copyFileSync(SNAPSHOT, copy)
  return bus(copy)
}

function queuesOf(db: DatabaseSync, after: number): unknown {
  return {
    tasks: db.prepare('SELECT task_key, queue, state FROM tasks ORDER BY task_key').all().map(row => ({ ...row })),
    events: db.prepare('SELECT type, dedupe_key, payload FROM events WHERE id > ? ORDER BY id').all(after).map(row => ({ ...row })),
  }
}

function cpuMsOf(usage: NodeJS.CpuUsage): number {
  return (usage.user + usage.system) / 1_000
}

function medianTickCpuMs(db: DatabaseSync, ts: string): number {
  const rounds = Array.from({ length: TICK_ROUNDS }, () => {
    const started = process.cpuUsage()
    deriveQueuesOfTheBus(db, ts)
    return cpuMsOf(process.cpuUsage(started))
  })
  return rounds.sort((a, b) => a - b)[Math.floor(TICK_ROUNDS / 2)]!
}

function lastId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

describe('the bus tick names the duration of every step', () => {
  it('a bus tick writes one line with the duration of every step', () => {
    const db = bus()
    const clock = new Clock()
    const tick = new BusTick(db, { folds: [busPrFolds()], incremental: [] }, new NetWatchThatTicks(db, new FakeGitHub().client, clock.now), clock.now, () => {}, () => {}, () => {}, stepClock()).run()
    expect(tick?.steps.map(each => each.step)).toEqual([...TICK_STEPS])
    expect(tick?.steps.every(each => each.ms === STEP_MS)).toBe(true)
    const timing = tickLines(tick!).filter(line => TICK_STEPS.every(step => line.includes(`${step} 0.01 s`)))
    expect(timing).toHaveLength(1)
  })

  it('a tick whose step hits a locked database still names the duration of that step', () => {
    const db = bus()
    const clock = new Clock()
    const locked = (): void => {
      throw new Error('database is locked')
    }
    const busTick = new BusTick(db, { folds: [busPrFolds()], incremental: [] }, new NetWatchThatTicks(db, new FakeGitHub().client, clock.now), clock.now, () => {}, () => {}, locked, stepClock())
    const lines = tickOrLocked(busTick)
    expect(busTick.lastSteps.map(each => each.step)).toEqual(TICK_STEPS.slice(0, TICK_STEPS.indexOf('StalledSessions') + 1))
    expect(lines.at(-1)).toContain('StalledSessions 0.01 s')
  })
})

describe('the slow steps of the tick', () => {
  it('pr status lookup by pr and head uses an index and not a scan of every pr.status.set event', () => {
    const plan = bus().prepare(`EXPLAIN QUERY PLAN ${LAST_STATUS_SET_ON_HEAD}`).all(52, 'b'.repeat(40)).map(row => String(row.detail)).join('\n')
    expect(plan).toContain('events_by_pr_head (pr=? AND head=? AND type=?)')
    expect(plan).not.toContain('events_by_type')
  })

  it('deriveQueues reads the decisions in force once per tick', () => {
    const db = bus()
    decisionReads.count = 0
    deriveQueuesOfTheBus(db, TS)
    expect(decisionReads.count).toBe(1)
  })

  it('a nested hold of the decisions gives the outer hold back when it ends', () => {
    const db = bus()
    const outer = new Date(TS)
    const inner = new Date(Date.parse(TS) + 1_000)
    decisionReads.count = 0
    withDecisionsHeldAt(db, outer, () => {
      withDecisionsHeldAt(db, inner, () => decisionsInForceAt(db, inner))
      decisionsInForceAt(db, outer)
    })
    expect(decisionReads.count).toBe(2)
    decisionsInForceAt(db, outer)
    expect(decisionReads.count).toBe(3)
  })
})

describe.skipIf(!existsSync(SNAPSHOT))('deriveQueues on a copy of the bus snapshot', () => {
  it('deriveQueues on a copy of the bus snapshot finishes under 2 s with the same queues as before', () => {
    const indexed = snapshotCopy()
    const before = snapshotCopy()
    before.exec('DROP INDEX events_by_pr_head')
    const after = lastId(indexed)
    const ts = new Date().toISOString()
    const derived = deriveQueuesOfTheBus(indexed, ts)
    expect(derived).toEqual(deriveQueuesOfTheBus(before, ts))
    expect(queuesOf(indexed, after)).toEqual(queuesOf(before, after))
    expect(medianTickCpuMs(indexed, ts)).toBeLessThan(DERIVE_BUDGET_MS)
  }, 900_000)
})
