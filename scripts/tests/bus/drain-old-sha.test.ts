import type { BgResult, DetachedLaunch, RunningProcess } from '../../supervisor/bg.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { LEASES_DRAINING } from '../../core/events.js'
import { completeTask, drainOpen, leaseNext, leaseWhileFree } from '../../core/lease.js'
import { queueTaskWithin } from '../../core/queue.js'
import { launchName, PREFIX } from '../../supervisor/bg.js'
import { busDrain, BusSupervisor, freeLeasesOf } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const MERGED_AT = Date.parse('2026-11-03T16:29:48.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bench() {
  const root = mkdtempSync(path.join(tmpdir(), 'drain-old-sha-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const clock = { now: 0 }
  const ts = (): string => new Date(MERGED_AT + clock.now).toISOString()
  const inFlight = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1438, pr: 1243, head: OLD_MAIN }, 'worker:answer:old', 1)!
  queueTaskWithin(db, ts(), { queue: 'launch', cardId: 1462 })
  const { answer, launch } = workerLaunches(() => [])
  let pid = 700
  let alive: RunningProcess[] = [{ pid: 600, args: `node pnpm.cjs --silent ${launchName(answer)} --on` }, { pid: 601, args: `node pnpm.cjs --silent ${launchName(launch)} --on` }]
  const started: string[] = []
  let head = OLD_MAIN
  const supervisor = new BusSupervisor({
    known: [answer, launch],
    wanted: () => [answer, launch],
    start: (each: DetachedLaunch): BgResult => {
      started.push(launchName(each))
      alive = [...alive, { pid: ++pid, args: `node pnpm.cjs --silent ${launchName(each)} --on` }]
      return { stdout: [`${PREFIX}pnpm ${launchName(each)}`], stderr: [], exitCode: 0 }
    },
    stop: async (instance) => {
      alive = alive.filter(candidate => candidate.pid !== instance.pid)
    },
    freeLeases: stopped => freeLeasesOf(db, ts(), stopped),
    drain: busDrain(db, ts),
    processes: () => alive,
    mainSince: () => [{ id: 1, sha: NEW_MAIN }],
    code: {
      head: () => head,
      holds: sha => sha === head,
      pull: () => {
        head = NEW_MAIN
      },
      changedSince: sha => sha === head ? [] : [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
    },
    journal: () => {},
    now: () => MERGED_AT + clock.now,
  }, 0)
  return { db, clock, ts, inFlight, answer, launch, started, alive: () => alive, supervisor }
}

function drains(db: ReturnType<typeof openBus>): unknown[] {
  return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(LEASES_DRAINING).map(row => JSON.parse(String(row.payload)) as unknown)
}

describe('a drain refuses new leases only to the processes on the old sha', () => {
  it('after main changes sha launch leases a new card before the old leases drain', async () => {
    const { db, ts, inFlight, launch, started, supervisor } = bench()

    const lines = (await supervisor.step()).join('\n')

    expect(lines).toContain(`${launchName(launch)} hold no lease in flight; restarted on ${NEW_MAIN} at once`)
    expect(started).toEqual([launchName(launch)])
    expect(drainOpen(db, ts(), 'launch', NEW_MAIN)).toBe(false)
    expect(leaseNext(db, ts(), 'launch', 'worker:launch:new')).toEqual(expect.objectContaining({ queue: 'launch', cardId: 1462 }))
    expect(db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(inFlight.taskKey)).toEqual({ state: 'leased' })
    db.close()
  })

  it('a worker on the old sha takes no new lease while the drain is open', async () => {
    const { db, ts, supervisor } = bench()

    expect((await supervisor.step()).join('\n')).toContain('bus:answer take no new one')

    expect(drains(db)).toEqual([expect.objectContaining({ node: 'answer', sha: NEW_MAIN, from: OLD_MAIN })])
    expect(drainOpen(db, ts(), 'answer', OLD_MAIN)).toBe(true)
    expect(drainOpen(db, ts(), 'answer', NEW_MAIN)).toBe(false)
    expect(drainOpen(db, ts(), 'answer')).toBe(true)
    db.close()
  })

  it('once the old leases finish only the drained worker restarts, and the launch restarted early keeps running', async () => {
    const { db, clock, ts, inFlight, answer, launch, started, alive, supervisor } = bench()

    await supervisor.step()
    clock.now = 60_000
    expect(started).toEqual([launchName(launch)])
    const early = alive().find(each => each.args.includes(launchName(launch)))!

    completeTask(db, ts(), inFlight, [])
    clock.now = 120_000
    expect((await supervisor.step()).join('\n')).toContain(`main advanced to ${NEW_MAIN}`)

    expect(started).toEqual([launchName(launch), launchName(answer)])
    expect(alive()).toContainEqual(early)
    db.close()
  })
})
