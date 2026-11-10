import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { NodeStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { BgResult, DetachedLaunch, RunningProcess } from '../../supervisor/bg.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../core/db.js'
import { CARD_ANSWERED, TASK_EXPIRED, WORKER_RETIRING } from '../../core/events.js'
import { completeTask, leasedByRetiring, leaseWhileFree, recordWorkerStarted, retiringPids, workerRetiring } from '../../core/lease.js'
import { Node } from '../../core/node.js'
import { keyOf, queueTaskWithin } from '../../core/queue.js'
import { launchName, PREFIX } from '../../supervisor/bg.js'
import { slotsVariable } from '../../supervisor/scheduler.js'
import { busDrain, BusSupervisor, DRAIN_LIMIT_MS, freeLeasesOf, withoutRetiring } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const MERGED_AT = Date.parse('2026-11-04T06:40:15.000Z')
const OLD_PID = 600
const OLD_WRAPPER_PID = 599
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class RoundNode extends Node<NodeStep> {
  readonly taken: string[] = []
  private readonly rounds: (() => void)[] = []
  private readonly awaitingTaken: { count: number, reached: () => void }[] = []

  constructor(db: DatabaseSync, clock: () => Date, session: string, private readonly codeOf: string, private readonly commit: (lease: Lease) => void) {
    super('answer', { db, clock, session, mode: 'live', env: { [slotsVariable('answer')]: '2' }, self: { pid: session === 'old' ? OLD_PID : 701, started: clock().toISOString() }, codeSha: () => codeOf })
  }

  protected candidates(): QueuedTask[] {
    return []
  }

  protected async handle(lease: Lease): Promise<NodeStep> {
    this.taken.push(`${this.codeOf}:${lease.taskKey}`)
    for (const waiting of this.awaitingTaken.filter(each => each.count <= this.taken.length)) {
      this.awaitingTaken.splice(this.awaitingTaken.indexOf(waiting), 1)
      waiting.reached()
    }
    await new Promise<void>((resolve) => {
      this.rounds.push(resolve)
    })
    this.commit(lease)
    return { kind: 'answered', taskKey: lease.taskKey }
  }

  tookRounds(count: number): Promise<void> {
    if (this.taken.length >= count)
      return Promise.resolve()
    return new Promise((reached) => {
      this.awaitingTaken.push({ count, reached })
    })
  }

  finish(): void {
    for (const round of this.rounds.splice(0))
      round()
  }
}

function bench(holderStart: { pid: number, started: string } | null = { pid: OLD_PID, started: new Date(MERGED_AT).toISOString() }) {
  const root = mkdtempSync(path.join(tmpdir(), 'drain-keeps-round-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const clock = { now: 0 }
  const date = (): Date => new Date(MERGED_AT + clock.now)
  const ts = (): string => date().toISOString()
  const { answer, close } = workerLaunches(() => [])
  let alive: RunningProcess[] = [{ pid: OLD_WRAPPER_PID, args: `node pnpm.cjs --silent ${launchName(answer)}` }, { pid: OLD_PID, args: `node --import tsx scripts/nodes/answer/answer-worker.ts --on` }]
  const started: string[] = []
  const stopped: number[] = []
  let head = OLD_MAIN
  const processes = withoutRetiring(() => alive, db)
  const supervisorOn = (known: DetachedLaunch[] = [answer]): BusSupervisor => new BusSupervisor({
    known,
    wanted: () => known,
    start: (launch): BgResult => {
      if (processes().some(each => each.args.includes(launchName(launch))))
        return { stdout: [], stderr: [`${launch.script} is already running`], exitCode: 1, alreadyRunning: processes()[0] }
      started.push(launchName(launch))
      alive = [...alive, { pid: 701, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
      return { stdout: [`${PREFIX}started`], stderr: [], exitCode: 0 }
    },
    stop: async (instance) => {
      stopped.push(instance.pid)
      alive = alive.filter(each => each.pid !== instance.pid)
    },
    freeLeases: list => freeLeasesOf(db, ts(), list),
    drain: busDrain(db, ts),
    processes,
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
  const commit = (lease: Lease): void => completeTask(db, ts(), lease, [{ ts: ts(), type: CARD_ANSWERED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_ANSWERED}:${lease.taskKey}`, payload: { head: 'the-commit' }, legacy: false }])
  if (holderStart !== null)
    recordWorkerStarted(db, ts(), 'worker:answer:old', holderStart)
  return { db, clock, ts, date, answer, close, started, stopped, alive: () => alive, processes, supervisorOn, commit }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

const eventsOf = (db: DatabaseSync, type: string): number => Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)

describe('a restart of the bus code keeps the rounds in flight', () => {
  it('a round begun before a bus code change ends in its own commit after the restart', async () => {
    const { db, clock, ts, date, started, stopped, alive, supervisorOn, commit, answer } = bench()
    const task: QueuedTask = { queue: 'answer', cardId: 1483 }
    queueTaskWithin(db, ts(), task)
    const old = new RoundNode(db, date, 'old', OLD_MAIN, commit)
    const running = old.run({ pause: nextTurn })
    await old.tookRounds(1)

    const lines = (await supervisorOn().step()).join('\n')
    expect(lines).toContain(`finishes the rounds it holds on ${OLD_MAIN} and exits`)
    expect(started).toEqual([launchName(answer)])
    expect(stopped).toEqual([])
    expect(alive().map(each => each.pid)).toContain(OLD_PID)

    clock.now = DRAIN_LIMIT_MS + 1
    const afterLimit = supervisorOn()
    await afterLimit.step()
    expect(stopped).toEqual([])
    expect(eventsOf(db, TASK_EXPIRED)).toBe(0)

    old.finish()
    await running
    expect(db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(keyOf(task))).toEqual({ state: 'completed' })
    expect(eventsOf(db, CARD_ANSWERED)).toBe(1)
    expect(eventsOf(db, TASK_EXPIRED)).toBe(0)
    db.close()
  })

  it('a new lease goes to the new code while the old round finishes', async () => {
    const { db, ts, date, supervisorOn, commit } = bench()
    queueTaskWithin(db, ts(), { queue: 'answer', cardId: 1483 })
    const old = new RoundNode(db, date, 'old', OLD_MAIN, commit)
    const oldRun = old.run({ pause: nextTurn })
    await old.tookRounds(1)

    await supervisorOn().step()
    expect(workerRetiring(db, 'worker:answer:old')).toBe(true)
    expect(leasedByRetiring(db, 'answer')).toBe(1)

    queueTaskWithin(db, ts(), { queue: 'answer', cardId: 1560 })
    const fresh = new RoundNode(db, date, 'new', NEW_MAIN, commit)
    const controller = new AbortController()
    const freshRun = fresh.run({ pause: nextTurn, signal: controller.signal })
    await fresh.tookRounds(1)
    expect(fresh.taken[0]).toContain(`${NEW_MAIN}:`)
    expect(fresh.taken[0]).toContain('1560')
    expect(old.taken).toHaveLength(1)

    old.finish()
    await oldRun
    fresh.finish()
    controller.abort()
    await freshRun
    expect(eventsOf(db, TASK_EXPIRED)).toBe(0)
    db.close()
  })

  it('a retiring worker holds its share of the slots, so the machine runs no more rounds than the queue has slots', async () => {
    const { db, ts, date, supervisorOn, commit } = bench()
    const old = new RoundNode(db, date, 'old', OLD_MAIN, commit)
    queueTaskWithin(db, ts(), { queue: 'answer', cardId: 1 })
    queueTaskWithin(db, ts(), { queue: 'answer', cardId: 2 })
    const oldRun = old.run({ pause: nextTurn })
    await old.tookRounds(2)
    await supervisorOn().step()

    queueTaskWithin(db, ts(), { queue: 'answer', cardId: 3 })
    const fresh = new RoundNode(db, date, 'new', NEW_MAIN, commit)
    const controller = new AbortController()
    let passes = 0
    const freshRun = fresh.run({
      pause: async () => {
        passes += 1
        if (passes > 2)
          controller.abort()
        await nextTurn()
      },
      signal: controller.signal,
    })
    await freshRun
    expect(fresh.taken).toEqual([])
    old.finish()
    await oldRun
    db.close()
  })

  it('a later stop of the new worker frees neither the lease of the retiring one nor stops its process', async () => {
    const { db, ts, alive, stopped, supervisorOn, answer } = bench()
    const held = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1483 }, 'worker:answer:old', 3)!
    await supervisorOn().step()

    expect(retiringPids(db)).toEqual(new Set([OLD_PID, OLD_WRAPPER_PID]))
    expect(freeLeasesOf(db, ts(), [answer])).toEqual([])
    expect(db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(held.taskKey)).toEqual({ state: 'leased' })
    expect(stopped).toEqual([])
    expect(alive().map(each => each.pid)).toEqual(expect.arrayContaining([OLD_WRAPPER_PID, OLD_PID, 701]))
    db.close()
  })

  it('once the round ends the old process shows again, so a pid that outlives its round is no longer hidden', async () => {
    const { db, ts, processes, supervisorOn } = bench()
    const held = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1483 }, 'worker:answer:old', 3)!
    await supervisorOn().step()
    expect(processes().map(each => each.pid)).not.toContain(OLD_PID)

    completeTask(db, ts(), held, [])

    expect(retiringPids(db)).toEqual(new Set())
    expect(processes().map(each => each.pid)).toContain(OLD_PID)
    db.close()
  })

  it('a heal that holds the bus sees the retiring process, so it can stop it', async () => {
    const { db, ts, alive, supervisorOn } = bench()
    leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1483 }, 'worker:answer:old', 3)
    await supervisorOn().step()

    const heldForHeal = withoutRetiring(alive, db, () => true)
    expect(heldForHeal().map(each => each.pid)).toContain(OLD_PID)
    expect(withoutRetiring(alive, db)().map(each => each.pid)).not.toContain(OLD_PID)
    db.close()
  })

  it('a worker of no round is not retired: its lease drains as before', async () => {
    const { db, ts, close, supervisorOn } = bench(null)
    recordWorkerStarted(db, ts(), 'worker:close:old', { pid: OLD_PID, started: ts() })
    leaseWhileFree(db, ts(), { queue: 'close', cardId: 1483 }, 'worker:close:old', 1)

    const lines = (await supervisorOn([close]).step()).join('\n')

    expect(lines).not.toContain('finishes the rounds it holds')
    expect(eventsOf(db, WORKER_RETIRING)).toBe(0)
    db.close()
  })

  it('a round lease no running instance proves it holds is not retired: nothing hides a live worker for it', async () => {
    const { db, ts, stopped, supervisorOn } = bench({ pid: 4242, started: new Date(MERGED_AT).toISOString() })
    leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1483 }, 'worker:answer:old', 3)

    const lines = (await supervisorOn().step()).join('\n')

    expect(lines).toContain('waits for the leases in flight to finish')
    expect(eventsOf(db, WORKER_RETIRING)).toBe(0)
    expect(stopped).toEqual([])
    db.close()
  })
})
