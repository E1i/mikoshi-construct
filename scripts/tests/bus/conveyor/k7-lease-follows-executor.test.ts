import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from '../../../core/events.js'
import type { HolderProcess, ProcessStartOf } from '../../../core/lease.js'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../../core/db.js'
import { BOARD_ALARM, CHILD_ENDED, SIGNAL_SENT, TASK_COMPLETED, TASK_EXPIRED, TASK_LEASED, TASK_RELEASED, TASK_RENEWED } from '../../../core/events.js'
import { aliveBy, leaseHandedOver } from '../../../core/handover.js'
import { completeTask, expireLeases, HOLDER_DEAD, HOLDER_UNPROVEN, judgeHolders, LEASE_MS, leaseNext, recordWorkerStarted, renewedByTheSupervisorFor, RESTART_CUT } from '../../../core/lease.js'
import { ChildLog, eventsIn, INSTANCE_VARIABLE, recordChildStarted } from '../../../core/node.js'
import { queueTask } from '../../../core/queue.js'
import { BusRead } from '../../../ports/bus-read.js'
import { OsProcessTable } from '../../../ports/process-table.js'
import { cardTransitions } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { tableIdentity } from '../../../supervisor/recorded-worker.js'
import { recordSignalSent } from '../../../supervisor/signal-sent.js'
import { LivenessJudge, psStartOf } from '../../../supervisor/supervisor.js'
import { waitFor } from '../../wait-for.js'

const CARD = 1912
const BRANCH = `card-${CARD}`
const PARENT = 'worker:answer:k7-parent'
const NEXT = 'worker:answer:k7-next'
const LAUNCH = 'worker:launch:k7'
const SCENARIO_MS = 60_000
const WAIT_MS = 20_000
const HELPER_POLL_S = 0.05
const HELPER_BOUND_TICKS = Math.ceil(SCENARIO_MS / 1000 / HELPER_POLL_S)
const PAST_A_LEASE_MS = LEASE_MS + 60_000

const table = new OsProcessTable()
const spawned: ChildProcess[] = []
const roots: string[] = []
const dbs: DatabaseSync[] = []

function killGroup(pid: number): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
    }
    catch {}
  }
}

afterEach(() => {
  for (const child of spawned.splice(0))
    killGroup(child.pid!)
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=k7', '-c', 'user.email=k7', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()
}

function inTable(pid: number): boolean {
  return tableIdentity(table)(pid) !== null
}

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
}

function spawnedDetached(command: string, args: string[]): { child: ChildProcess, exited: Promise<Exit> } {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  spawned.push(child)
  return { child, exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))) }
}

class Clock {
  private offsetMs = 0

  now(): number {
    return Date.now() + this.offsetMs
  }

  ts(): string {
    return new Date(this.now()).toISOString()
  }

  passLease(): void {
    this.offsetMs += PAST_A_LEASE_MS
  }
}

class World {
  readonly root = mkdtempSync(path.join(tmpdir(), 'k7-lease-follows-'))
  readonly remote = path.join(this.root, 'remote.git')
  readonly tree = path.join(this.root, 'tree')
  readonly release = path.join(this.root, 'release')
  readonly db: DatabaseSync = openBus(path.join(this.root, 'bus.db'))
  readonly clock = new Clock()
  readonly judge = new LivenessJudge(this.db, () => this.clock.now(), () => () => false, async () => [], psStartOf)

  constructor() {
    roots.push(this.root)
    dbs.push(this.db)
    git(this.root, 'init', '-q', '--bare', this.remote)
    git(this.root, 'clone', '-q', this.remote, this.tree)
    git(this.tree, 'commit', '-q', '--allow-empty', '-m', 'base')
    git(this.tree, 'push', '-q', 'origin', 'HEAD:main')
    git(this.tree, 'checkout', '-q', '-b', BRANCH)
  }

  read(): BusRead {
    return new BusRead(this.db)
  }

  count(type: EventType): number {
    return this.read().slice(type, ['task_key']).length
  }

  remoteHead(): string | null {
    try {
      return git(this.root, '--git-dir', this.remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`)
    }
    catch {
      return null
    }
  }

  async parentWorker(): Promise<ChildProcess> {
    const { child } = spawnedDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await waitFor(() => inTable(child.pid!), () => 'the parent worker to enter the process table', WAIT_MS)
    const identity = tableIdentity(table)(child.pid!)!
    recordWorkerStarted(this.db, this.clock.ts(), PARENT, { pid: child.pid!, started: new Date(Date.parse(identity.lstart)).toISOString() })
    return child
  }

  async session(taskKey: string): Promise<{ child: ChildProcess, exited: Promise<Exit> }> {
    const loop = `n=0; while [ ! -f "$0" ]; do n=$((n+1)); [ "$n" -gt ${HELPER_BOUND_TICKS} ] && exit 124; sleep ${HELPER_POLL_S}; done; git -C "$1" -c user.name=k7 -c user.email=k7 commit -q --allow-empty -m "the answer of the orphaned session" && git -C "$1" push -q origin HEAD`
    const session = spawnedDetached('sh', ['-c', loop, this.release, this.tree])
    await waitFor(() => inTable(session.child.pid!), () => 'the session to enter the process table', WAIT_MS)
    const log = new ChildLog(write => write(this.db), tableIdentity(table), () => new Date(this.clock.now()), { [INSTANCE_VARIABLE]: 'k7' })
    expect(log.started({ actor: PARENT, taskKey, kind: 'answer', tree: this.tree }, session.child.pid!), 'child.started registers the session').toBe(true)
    return session
  }

  async judged(): Promise<string[]> {
    return this.judge.step()
  }

  noNewLease(): void {
    const ts = this.clock.ts()
    expect(expireLeases(this.db, cardTransitions(), ts, SILENT_MS), 'no timer frees the lease of a live executor').toEqual([])
    const alive = aliveBy(tableIdentity(table))
    expect(leaseHandedOver(this.db, eventsIn(this.db), ts, 'answer', NEXT, undefined, alive), 'no new lease on the task').toBeNull()
    expect(leaseHandedOver(this.db, eventsIn(this.db), ts, 'launch', LAUNCH, undefined, alive), 'no new lease on the card tree').toBeNull()
  }
}

describe('k7: the lease follows the executor over a recorded process table', () => {
  const T0 = Date.parse('2026-11-17T10:00:00.000Z')
  const HOLDER = { pid: 4101, lstart: '2026-11-17T09:59:00.000Z' }
  const EXECUTOR = { pid: 4102, lstart: '2026-11-17T09:59:30.000Z' }

  function bench(): { db: DatabaseSync, at: (ms: number) => string, key: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'k7-recorded-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    const at = (ms: number): string => new Date(T0 + ms).toISOString()
    queueTask(db, at(0), { queue: 'answer', cardId: CARD })
    recordWorkerStarted(db, at(0), PARENT, { pid: HOLDER.pid, started: HOLDER.lstart })
    const { taskKey } = leaseNext(db, at(0), 'answer', PARENT)!
    expect(recordChildStarted(db, at(1_000), PARENT, { mode: 'child', instance: 'k7', generation: 'g', pid: EXECUTOR.pid, pgid: EXECUTOR.pid, lstart: EXECUTOR.lstart, kind: 'answer', taskKey, tree: '/trees/1912' })).toBe(true)
    return { db, at, key: taskKey }
  }

  function readings(running: Record<number, HolderProcess>): ProcessStartOf {
    return pid => running[pid] ?? { state: 'gone' }
  }

  const live: HolderProcess = { state: 'running', started: EXECUTOR.lstart }

  it('a holder that has ended leaves its lease to the live executor: the supervisor renews it, no timer frees it, and it is freed once the executor is gone', () => {
    const { db, at, key } = bench()
    expect(judgeHolders(db, cardTransitions(), at(LEASE_MS + 60_000), readings({ [EXECUTOR.pid]: live }), SILENT_MS)).toMatchObject({ renewed: [key], freed: [] })
    expect(judgeHolders(db, cardTransitions(), at(LEASE_MS + 90_000), readings({ [EXECUTOR.pid]: live }), SILENT_MS), 'renewed at most once per renewal period').toEqual({ freed: [], hung: [], unproven: [] })
    expect(expireLeases(db, cardTransitions(), at(3 * LEASE_MS), SILENT_MS)).toEqual([])
    expect(new BusRead(db).slice(TASK_RENEWED, ['task_key']).map(each => ({ actor: each.actor, ...each.fields }))).toEqual([{ actor: renewedByTheSupervisorFor(EXECUTOR.pid), task_key: key }])
    expect(new BusRead(db).slice(TASK_EXPIRED, ['task_key'])).toEqual([])

    expect(judgeHolders(db, cardTransitions(), at(3 * LEASE_MS), readings({}), SILENT_MS)).toEqual({ freed: [key], hung: [], unproven: [] })
    expect(new BusRead(db).slice(TASK_EXPIRED, ['reason']).map(each => each.fields.reason)).toEqual([HOLDER_DEAD])
  })

  it('an executor whose liveness cannot be read raises holder_unproven and keeps the lease', () => {
    const { db, at, key } = bench()
    const unreadable = readings({ [EXECUTOR.pid]: { state: 'unreadable' } })
    expect(judgeHolders(db, cardTransitions(), at(LEASE_MS + 60_000), unreadable, SILENT_MS)).toEqual({ unproven: [key], freed: [], hung: [] })
    expect(expireLeases(db, cardTransitions(), at(LEASE_MS + 60_000), SILENT_MS)).toEqual([])
    expect(new BusRead(db).slice(BOARD_ALARM, ['reason']).map(each => each.fields.reason)).toEqual([HOLDER_UNPROVEN])
    expect((db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key) as { state: string }).state).toBe('leased')
  })

  it('a stopped executor returns its task only through signal.sent and its child.ended with that signal, never as task.expired', () => {
    const { db, at, key } = bench()
    recordSignalSent(db, at(2_000), { child: { mode: 'child', instance: 'k7', generation: 'g', pid: EXECUTOR.pid, pgid: EXECUTOR.pid, lstart: EXECUTOR.lstart, kind: 'answer', taskKey: key, tree: null }, signal: 'SIGTERM', why: 'drain' })
    expect(judgeHolders(db, cardTransitions(), at(3_000), readings({}), SILENT_MS)).toEqual({ returned: [key], freed: [], hung: [], unproven: [] })
    const read = new BusRead(db)
    expect(read.slice(CHILD_ENDED, ['pid', 'exit', 'signal', 'task_key']).map(each => each.fields)).toEqual([{ pid: EXECUTOR.pid, exit: null, signal: 'SIGTERM', task_key: key }])
    expect(read.slice(TASK_RELEASED, ['reason']).map(each => each.fields.reason)).toEqual([RESTART_CUT])
    expect(read.slice(TASK_EXPIRED, ['task_key'])).toEqual([])
    expect(leaseNext(db, at(4_000), 'answer', NEXT)).toMatchObject({ taskKey: key, actor: NEXT })
  })
})

describe('k7 [needs ps]: scenario 12, the lease follows the executor', () => {
  it('scenario 12: with the parent worker SIGKILLed by pid, the supervisor renews the lease for the live detached session; it ends 0, its commit is pushed and the task completes with no signal.sent', async () => {
    const world = new World()
    const task = { queue: 'answer' as const, cardId: CARD }
    queueTask(world.db, world.clock.ts(), task)
    const parent = await world.parentWorker()
    const lease = leaseNext(world.db, world.clock.ts(), 'answer', PARENT)!
    expect(lease).toMatchObject({ cardId: CARD, actor: PARENT })
    const session = await world.session(lease.taskKey)
    const sessionPid = session.child.pid!
    queueTask(world.db, world.clock.ts(), { queue: 'launch', cardId: CARD })

    process.kill(parent.pid!, 'SIGKILL')
    await waitFor(() => !inTable(parent.pid!), () => 'the parent worker to leave the process table', WAIT_MS)
    expect(inTable(sessionPid), 'the orphaned session lives on').toBe(true)

    for (let round = 1; round <= 2; round++) {
      world.clock.passLease()
      world.noNewLease()
      const lines = await world.judged()
      expect(lines.join('\n')).toContain(lease.taskKey)
      world.noNewLease()
      const renewed = world.read().slice(TASK_RENEWED, ['task_key'])
      expect(renewed.map(each => ({ actor: each.actor, ...each.fields }))).toEqual(Array.from({ length: round }, () => ({ actor: renewedByTheSupervisorFor(sessionPid), task_key: lease.taskKey })))
      expect(world.count(TASK_EXPIRED), 'no task.expired while the executor lives').toBe(0)
      expect(world.read().slice(TASK_LEASED, ['task_key']).map(each => each.actor)).toEqual([PARENT])
      const lapse = world.db.prepare('SELECT state, lease_until FROM tasks WHERE task_key = ?').get(lease.taskKey) as { state: string, lease_until: string }
      expect(lapse.state).toBe('leased')
      expect(Date.parse(lapse.lease_until)).toBeGreaterThan(world.clock.now())
      expect(inTable(sessionPid)).toBe(true)
    }
    expect(world.read().slice(BOARD_ALARM, ['reason']).map(each => each.fields.reason)).not.toContain(HOLDER_UNPROVEN)
    expect(world.remoteHead()).toBeNull()

    writeFileSync(world.release, '')
    expect(await session.exited, 'the session ends on its own status').toEqual({ code: 0, signal: null })
    expect(world.remoteHead(), 'the commit of the session is pushed').toBe(git(world.tree, 'rev-parse', 'HEAD'))
    expect(git(world.tree, 'status', '--porcelain')).toBe('')
    expect(world.count(TASK_EXPIRED)).toBe(0)

    await world.judged()
    const next = leaseNext(world.db, world.clock.ts(), 'answer', NEXT)
    expect(next, 'the task is leased again only once its executor is proven ended').toMatchObject({ taskKey: lease.taskKey, actor: NEXT })
    completeTask(world.db, cardTransitions(), world.clock.ts(), next!, [])

    const completed = world.read().slice(TASK_COMPLETED, ['task_key'])
    expect(completed.map(each => ({ actor: each.actor, task: each.fields.task_key }))).toEqual([{ actor: NEXT, task: lease.taskKey }])
    expect((world.db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(lease.taskKey) as { state: string }).state).toBe('completed')
    expect(world.read().slice(SIGNAL_SENT, ['pid'])).toEqual([])
  }, SCENARIO_MS)
})
