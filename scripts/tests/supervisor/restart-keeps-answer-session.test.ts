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
import { CARD_ANSWERED, TASK_EXPIRED, TASK_FAILED, TASK_RELEASED } from '../../core/events.js'
import { completeTask, leaseWhileFree, recordWorkerStarted, RESTART_CUT } from '../../core/lease.js'
import { Node } from '../../core/node.js'
import { keyOf, queueTaskWithin } from '../../core/queue.js'
import { AnswerOutcomes } from '../../nodes/answer/duties/outcomes.js'
import { launchName, PREFIX } from '../../supervisor/bg.js'
import { slotsVariable } from '../../supervisor/scheduler.js'
import { busDrain, BusSupervisor, freeLeasesOf, withoutRetiring } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const MERGED_AT = Date.parse('2026-11-09T18:45:26.000Z')
const ANSWER_WRAPPER_PID = 599
const ANSWER_PID = 600
const CLOSE_PID = 610
const FRESH_PID = 701
const PROMISE_TURNS = 10_000
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class AnswerSession extends Node<NodeStep> {
  readonly taken: string[] = []
  private readonly rounds: (() => void)[] = []

  constructor(db: DatabaseSync, clock: () => Date, private readonly commit: (lease: Lease) => void) {
    super('answer', { db, clock, session: 'old', mode: 'live', env: { [slotsVariable('answer')]: '2' }, self: { pid: ANSWER_PID, started: clock().toISOString() }, codeSha: () => OLD_MAIN })
  }

  protected candidates(): QueuedTask[] {
    return []
  }

  protected async handle(lease: Lease): Promise<NodeStep> {
    this.taken.push(lease.taskKey)
    await new Promise<void>((resolve) => {
      this.rounds.push(resolve)
    })
    this.commit(lease)
    return { kind: 'answered', taskKey: lease.taskKey }
  }

  finish(): void {
    for (const round of this.rounds.splice(0))
      round()
  }
}

async function untilTrue(condition: () => boolean): Promise<void> {
  for (let turns = 0; turns < PROMISE_TURNS && !condition(); turns++)
    await Promise.resolve()
  expect(condition()).toBe(true)
}

const eventsOf = (db: DatabaseSync, type: string): number => Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)

function bench() {
  const root = mkdtempSync(path.join(tmpdir(), 'restart-keeps-answer-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const clock = { now: 0 }
  const date = (): Date => new Date(MERGED_AT + clock.now)
  const ts = (): string => date().toISOString()
  const { answer, close } = workerLaunches(() => [])
  let alive: RunningProcess[] = [
    { pid: CLOSE_PID, args: `node pnpm.cjs --silent ${launchName(close)}` },
    { pid: ANSWER_WRAPPER_PID, args: `node pnpm.cjs --silent ${launchName(answer)}` },
    { pid: ANSWER_PID, args: `node --import tsx scripts/nodes/answer/answer-worker.ts --on` },
  ]
  const stopped: number[] = []
  const freedFor: string[] = []
  const whileStopping: { close: () => Promise<void> } = { close: async () => {} }
  let head = OLD_MAIN
  const processes = withoutRetiring(() => alive, db)
  const known: DetachedLaunch[] = [close, answer]
  const supervisor = new BusSupervisor({
    known,
    wanted: () => known,
    start: (launch): BgResult => {
      alive = [...alive, { pid: FRESH_PID, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
      return { stdout: [`${PREFIX}started`], stderr: [], exitCode: 0 }
    },
    stop: async (instance, launch) => {
      if (launch === close)
        await whileStopping.close()
      stopped.push(instance.pid)
      alive = alive.filter(each => each.pid !== instance.pid)
    },
    freeLeases: (list) => {
      freedFor.push(...list.map(launchName))
      return freeLeasesOf(db, ts(), list)
    },
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
  const commit = (lease: Lease): void => completeTask(db, ts(), lease, [{ ts: ts(), type: CARD_ANSWERED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_ANSWERED}:${lease.taskKey}`, payload: { head: 'the-push' }, legacy: false }])
  recordWorkerStarted(db, ts(), 'worker:answer:old', { pid: ANSWER_PID, started: ts() })
  return { db, ts, date, stopped, freedFor, close, supervisor, commit, whileStopping }
}

function outcomesOn(db: DatabaseSync, date: () => Date): AnswerOutcomes {
  return new AnswerOutcomes({ db, clock: date, ownerMerges: () => '' }, { pathsIn: () => [], ownerBoundary: () => undefined, wideningAsked: () => [] })
}

describe('a restart after merge.done keeps a live answer session', () => {
  it('merge.done while an answer session is live lets the session reach push', async () => {
    const { db, ts, date, stopped, freedFor, close, supervisor, commit, whileStopping } = bench()
    const task: QueuedTask = { queue: 'answer', cardId: 1753 }
    const session = new AnswerSession(db, date, commit)
    const controller = new AbortController()
    const running = session.run({ pause: async () => {}, signal: controller.signal })
    whileStopping.close = async () => {
      queueTaskWithin(db, ts(), task)
      await untilTrue(() => session.taken.length === 1)
    }

    const lines = (await supervisor.step()).join('\n')
    session.finish()
    controller.abort()
    await running

    expect(stopped).toEqual([CLOSE_PID])
    expect(freedFor).toEqual([launchName(close)])
    expect(lines).toContain(`finishes the rounds it holds on ${OLD_MAIN} and exits`)
    expect(db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(keyOf(task))).toEqual({ state: 'completed' })
    expect(eventsOf(db, CARD_ANSWERED)).toBe(1)
    expect(eventsOf(db, TASK_EXPIRED)).toBe(0)
    db.close()
  })

  it('an answer session cut by a restart is requeued without answer_failed', async () => {
    const { db, ts, date, supervisor } = bench()
    const task: QueuedTask = { queue: 'answer', cardId: 1755 }
    const lease = leaseWhileFree(db, ts(), task, 'worker:answer:old', 2)!
    await supervisor.step()

    const outcome = outcomesOn(db, date).denied(lease, { kind: 'technical', reason: 'answer_failed', detail: 'the session exited 143' })

    expect(outcome).toMatchObject({ kind: 'denied', next: 'queued' })
    expect(db.prepare('SELECT state, failures FROM tasks WHERE task_key = ?').get(keyOf(task))).toEqual({ state: 'queued', failures: 0 })
    expect(eventsOf(db, TASK_FAILED)).toBe(0)
    expect(db.prepare('SELECT json_extract(payload, \'$.reason\') AS reason FROM events WHERE type = ?').all(TASK_RELEASED)).toEqual([{ reason: RESTART_CUT }])
    db.close()
  })

  it('an answer_failed with no restart during its lease still counts as a failed round', () => {
    const { db, ts, date } = bench()
    const task: QueuedTask = { queue: 'answer', cardId: 1755 }
    const lease = leaseWhileFree(db, ts(), task, 'worker:answer:old', 2)!

    outcomesOn(db, date).denied(lease, { kind: 'technical', reason: 'answer_failed', detail: 'the session exited 1' })

    expect(db.prepare('SELECT state, failures FROM tasks WHERE task_key = ?').get(keyOf(task))).toEqual({ state: 'queued', failures: 1 })
    expect(eventsOf(db, TASK_RELEASED)).toBe(0)
    db.close()
  })
})
