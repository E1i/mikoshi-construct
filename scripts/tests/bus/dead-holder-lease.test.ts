import type { DatabaseSync } from 'node:sqlite'
import type { HolderProcess, HolderStart, Lease } from '../../core/lease.js'
import type { RunningProcess } from '../../supervisor/bg.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../core/db.js'
import { BOARD_ALARM, TASK_EXPIRED, WORKER_STARTED } from '../../core/events.js'
import { completeTask, HOLDER_DEAD, HOLDER_UNPROVEN, judgeHolders, LEASE_MS, leaseNext, leaseQueued, leaseWhileFree, recordWorkerStarted, releaseTask, renewLease, SAME_START_MS, StaleLease, WORKER_HUNG } from '../../core/lease.js'
import { launchName, PREFIX } from '../../supervisor/bg.js'
import { ownStart } from '../../supervisor/heartbeat.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { busDrain, BusSupervisor, freeLeasesOf, LivenessJudge, lstartToIso, psStartOf } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'
import { sha } from './github-fake.js'

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const STARTED_AT = Date.parse('2026-10-22T16:00:00.000Z')
const DIED_HOLDER = 'worker:merge:6d1eb212'
const NEW_HOLDER = 'worker:merge:a1b2c3d4'
const DEAD_PID = 4242
const NEW_PID = 4343
const OLD_MAIN = sha('1')
const NEW_MAIN = sha('2')
const SHARED_FILE = 'scripts/core/db.ts'

interface Bench {
  db: DatabaseSync
  clock: { now: number }
  ts: () => string
  processes: Map<number, HolderProcess>
  startOf: (pid: number) => HolderProcess
  start: (worker: string, pid: number) => HolderStart
  judge: LivenessJudge
}

function bench(): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'dead-holder-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const clock = { now: 0 }
  const ts = (): string => new Date(STARTED_AT + clock.now).toISOString()
  const processes = new Map<number, HolderProcess>()
  const startOf = (pid: number): HolderProcess => processes.get(pid) ?? { state: 'gone' }
  const start = (worker: string, pid: number): HolderStart => {
    const holder = { pid, started: ts() }
    processes.set(pid, { state: 'running', started: holder.started })
    recordWorkerStarted(db, ts(), worker, holder)
    return holder
  }
  const judge = new LivenessJudge(db, () => STARTED_AT + clock.now, () => () => false, async () => [], pid => startOf(pid))
  return { db, clock, ts, processes, startOf, start, judge }
}

const PS_REFUSED_HERE = (spawnSync('ps', ['-p', String(process.pid)]).error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'

const mergeTask = { queue: 'merge' as const, cardId: 1250, pr: 1250, head: sha('a') }

function stateOf(db: DatabaseSync, key: string): { state: string, lease_gen: number } {
  return db.prepare('SELECT state, lease_gen FROM tasks WHERE task_key = ?').get(key) as { state: string, lease_gen: number }
}

function payloadsOf(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
}

function eventCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
}

function heldByTheDead(b: Bench): Lease {
  b.start(DIED_HOLDER, DEAD_PID)
  const lease = leaseWhileFree(b.db, b.ts(), mergeTask, DIED_HOLDER, 1)!
  b.processes.delete(DEAD_PID)
  return lease
}

describe('a lease whose holder process is dead is freed at once', () => {
  it('a merge lease whose holder process has exited gets task.expired with reason holder dead within one tick and a new worker completes the task', async () => {
    const b = bench()
    const lease = heldByTheDead(b)
    b.clock.now = 60_000

    const lines = (await b.judge.step()).join('\n')

    expect(payloadsOf(b.db, TASK_EXPIRED)).toEqual([expect.objectContaining({ task_key: lease.taskKey, reason: HOLDER_DEAD, next: 'queued', lease_gen: lease.leaseGen })])
    expect(lines).toContain(`(${HOLDER_DEAD}) and queued again: ${lease.taskKey}`)
    expect(stateOf(b.db, lease.taskKey).state).toBe('queued')
    b.start(NEW_HOLDER, NEW_PID)
    const taken = leaseQueued(b.db, b.ts(), lease.taskKey, NEW_HOLDER)!
    expect(taken.leaseGen).toBe(lease.leaseGen + 1)
    completeTask(b.db, b.ts(), taken, [])
    expect(stateOf(b.db, lease.taskKey).state).toBe('completed')
  })

  it('a holder pid taken by another process with a different start time is released as dead', () => {
    const b = bench()
    const lease = heldByTheDead(b)
    b.clock.now = 3 * 60 * 60_000
    b.processes.set(DEAD_PID, { state: 'running', started: b.ts() })

    expect(judgeHolders(b.db, b.ts(), b.startOf).freed).toEqual([lease.taskKey])
    expect(payloadsOf(b.db, TASK_EXPIRED)).toEqual([expect.objectContaining({ task_key: lease.taskKey, reason: HOLDER_DEAD })])
  })

  it('a holder pid still running under its recorded start time is not freed', () => {
    const b = bench()
    b.start(DIED_HOLDER, DEAD_PID)
    const lease = leaseWhileFree(b.db, b.ts(), mergeTask, DIED_HOLDER, 1)!

    expect(judgeHolders(b.db, b.ts(), b.startOf)).toEqual({ freed: [], hung: [], unproven: [] })
    expect(stateOf(b.db, lease.taskKey)).toEqual({ state: 'leased', lease_gen: lease.leaseGen })
  })

  it('a live holder with a stale heartbeat keeps its lease and raises a hung-worker alarm', async () => {
    const b = bench()
    b.start(DIED_HOLDER, DEAD_PID)
    const lease = leaseWhileFree(b.db, b.ts(), mergeTask, DIED_HOLDER, 1)!
    b.clock.now = SILENT_MS - 1
    await b.judge.step()
    expect(payloadsOf(b.db, BOARD_ALARM)).toEqual([])

    b.clock.now = SILENT_MS + 1
    const lines = (await b.judge.step()).join('\n')

    expect(stateOf(b.db, lease.taskKey)).toEqual({ state: 'leased', lease_gen: lease.leaseGen })
    expect(payloadsOf(b.db, TASK_EXPIRED)).toEqual([])
    expect(payloadsOf(b.db, BOARD_ALARM)).toEqual([expect.objectContaining({ reason: WORKER_HUNG, lease: lease.taskKey, lease_gen: lease.leaseGen, worker: DIED_HOLDER })])
    expect(lines).toContain(`${WORKER_HUNG} is on the board: ${lease.taskKey}`)
    await b.judge.step()
    expect(payloadsOf(b.db, BOARD_ALARM)).toHaveLength(1)
  })

  it('a renewed lease of a live holder raises no hung-worker alarm', () => {
    const b = bench()
    b.start(DIED_HOLDER, DEAD_PID)
    const lease = leaseWhileFree(b.db, b.ts(), mergeTask, DIED_HOLDER, 1)!
    b.clock.now = SILENT_MS - 60_000
    renewLease(b.db, b.ts(), lease)
    b.clock.now = SILENT_MS + 60_000

    expect(judgeHolders(b.db, b.ts(), b.startOf)).toEqual({ freed: [], hung: [], unproven: [] })
  })

  it('a new worker of the same kind does not take the lease of a live older worker', async () => {
    const b = bench()
    b.start(DIED_HOLDER, DEAD_PID)
    const lease = leaseWhileFree(b.db, b.ts(), mergeTask, DIED_HOLDER, 1)!
    b.clock.now = 60_000
    b.start(NEW_HOLDER, NEW_PID)

    await b.judge.step()

    expect(stateOf(b.db, lease.taskKey)).toEqual({ state: 'leased', lease_gen: lease.leaseGen })
    expect(leaseQueued(b.db, b.ts(), lease.taskKey, NEW_HOLDER)).toBeNull()
    expect(leaseNext(b.db, b.ts(), 'merge', NEW_HOLDER)).toBeNull()
    expect(payloadsOf(b.db, TASK_EXPIRED)).toEqual([])
  })

  it('a holder with no worker.started record keeps its lease and raises an unproven-holder alarm once silent', () => {
    const b = bench()
    const lease = leaseWhileFree(b.db, b.ts(), mergeTask, DIED_HOLDER, 1)!
    expect(judgeHolders(b.db, b.ts(), b.startOf)).toEqual({ freed: [], hung: [], unproven: [] })

    b.clock.now = SILENT_MS + 1
    expect(judgeHolders(b.db, b.ts(), b.startOf)).toEqual({ freed: [], hung: [], unproven: [lease.taskKey] })
    expect(stateOf(b.db, lease.taskKey).state).toBe('leased')
    expect(payloadsOf(b.db, BOARD_ALARM)).toEqual([expect.objectContaining({ reason: HOLDER_UNPROVEN, lease: lease.taskKey })])
  })

  it('a holder whose process cannot be read keeps its lease', () => {
    const b = bench()
    const lease = heldByTheDead(b)
    b.processes.set(DEAD_PID, { state: 'unreadable' })
    b.clock.now = SILENT_MS + 1

    expect(judgeHolders(b.db, b.ts(), b.startOf)).toEqual({ freed: [], hung: [], unproven: [lease.taskKey] })
    expect(payloadsOf(b.db, TASK_EXPIRED)).toEqual([])
  })

  it('the old worker with the previous lease_gen gets StaleLease after the release and writes nothing', () => {
    const b = bench()
    const lease = heldByTheDead(b)
    judgeHolders(b.db, b.ts(), b.startOf)
    b.start(NEW_HOLDER, NEW_PID)
    const taken = leaseQueued(b.db, b.ts(), lease.taskKey, NEW_HOLDER)!
    const before = eventCount(b.db)

    expect(() => completeTask(b.db, b.ts(), lease, [])).toThrow(StaleLease)
    expect(() => renewLease(b.db, b.ts(), lease)).toThrow(StaleLease)
    expect(eventCount(b.db)).toBe(before)
    expect(stateOf(b.db, lease.taskKey)).toEqual({ state: 'leased', lease_gen: taken.leaseGen })
  })

  it('a lease issued again between the reading and the release stays with its new holder', () => {
    const b = bench()
    const lease = heldByTheDead(b)
    b.start(NEW_HOLDER, NEW_PID)
    let reissued: Lease | null = null
    const reissuingStartOf = (pid: number): HolderProcess => {
      if (pid === DEAD_PID && reissued === null) {
        releaseTask(b.db, b.ts(), lease, 'handed over')
        reissued = leaseQueued(b.db, b.ts(), lease.taskKey, NEW_HOLDER)
      }
      return b.startOf(pid)
    }

    expect(judgeHolders(b.db, b.ts(), reissuingStartOf).freed).toEqual([])
    expect(stateOf(b.db, lease.taskKey)).toEqual({ state: 'leased', lease_gen: lease.leaseGen + 1 })
    expect(payloadsOf(b.db, TASK_EXPIRED)).toEqual([])
  })

  it('the worker.started record names the worker, its pid and its start time once per worker', () => {
    const b = bench()
    const holder = b.start(DIED_HOLDER, DEAD_PID)
    expect(recordWorkerStarted(b.db, b.ts(), DIED_HOLDER, holder)).toBe(false)
    expect(payloadsOf(b.db, WORKER_STARTED)).toEqual([{ worker: DIED_HOLDER, pid: DEAD_PID, started: holder.started }])
  })

  it('a ps lstart line reads as an instant, and anything else as unreadable', () => {
    expect(lstartToIso('Fri Oct 23 16:54:50 2026')).toMatch(/^2026-10-2\dT\d\d:54:50\.000Z$/)
    expect(lstartToIso('not a time')).toBeNull()
  })

  it.skipIf(PS_REFUSED_HERE)('ps reads this running process with a start time within SAME_START_MS of its own', () => {
    const read = psStartOf(process.pid)
    expect(read.state).toBe('running')
    const started = read.state === 'running' ? Date.parse(read.started) : Number.NaN
    expect(Math.abs(started - Date.parse(ownStart().started))).toBeLessThan(SAME_START_MS)
  })

  it('a pid whose process has exited reads as gone', () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    expect(psStartOf(exited)).toEqual({ state: 'gone' })
  })

  it('a live pid that ps cannot read is unreadable, never gone', () => {
    vi.stubEnv('PATH', '')
    expect(psStartOf(process.pid)).toEqual({ state: 'unreadable' })
  })
})

describe('the restart drain waits only for the leases of live holders', () => {
  function drainBench(b: Bench, holder: { worker: string, pid: number, dies: boolean }): { supervisor: BusSupervisor, lease: Lease, alive: () => RunningProcess[] } {
    b.start(holder.worker, holder.pid)
    const lease = leaseWhileFree(b.db, b.ts(), mergeTask, holder.worker, 1)!
    if (holder.dies)
      b.processes.delete(holder.pid)
    const merge = workerLaunches(() => []).merge
    let alive: RunningProcess[] = [{ pid: 600, args: `node pnpm.cjs --silent ${launchName(merge)} --on` }]
    let head = OLD_MAIN
    const supervisor = new BusSupervisor({
      known: [merge],
      wanted: () => [merge],
      start: launch => ({ stdout: [`${PREFIX}pnpm ${launchName(launch)}`], stderr: [], exitCode: 0 }),
      stop: async (instance) => {
        alive = alive.filter(candidate => candidate.pid !== instance.pid)
      },
      freeLeases: stopped => freeLeasesOf(b.db, b.ts(), stopped),
      drain: busDrain(b.db, b.ts, pid => b.startOf(pid)),
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
      now: () => STARTED_AT + b.clock.now,
    }, 0)
    return { supervisor, lease, alive: () => alive }
  }

  it('a restart onto a new main does not wait out the lease of a dead holder and waits for a live one', async () => {
    const dead = bench()
    const gone = drainBench(dead, { worker: DIED_HOLDER, pid: DEAD_PID, dies: true })
    const restarted = (await gone.supervisor.step()).join('\n')
    expect(restarted).not.toContain('waits for the leases in flight')
    expect(restarted).toContain(`main advanced to ${NEW_MAIN} with a change to the code every bus process runs`)
    expect(payloadsOf(dead.db, TASK_EXPIRED)).toEqual([expect.objectContaining({ task_key: gone.lease.taskKey, reason: HOLDER_DEAD })])

    const live = bench()
    const running = drainBench(live, { worker: DIED_HOLDER, pid: DEAD_PID, dies: false })
    const waiting = (await running.supervisor.step()).join('\n')
    expect(waiting).toContain(`the restart onto ${NEW_MAIN} waits for the leases in flight to finish, and no worker takes a new one: ${running.lease.taskKey}`)
    expect(running.alive()).toHaveLength(1)
    expect(stateOf(live.db, running.lease.taskKey).state).toBe('leased')
    live.clock.now = LEASE_MS / 2
    expect((await running.supervisor.step()).join('\n')).not.toContain('restarting every running bus process')
  })
})
