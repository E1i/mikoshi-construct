import type { DatabaseSync } from 'node:sqlite'
import type { BgResult, DetachedLaunch, RunningProcess } from '../../supervisor/bg.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { PR_OBSERVED, SIGNAL_SENT, TASK_EXPIRED, TASK_LEASED, WORKER_RETIRING } from '../../core/events.js'
import { recordChildStarted, recordWorkerIdentity } from '../../core/handover.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { QUEUE_ACTOR, queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { BusRead } from '../../ports/bus-read.js'
import { InMemoryProcessTable } from '../../ports/process-table.js'
import { launchName, PREFIX } from '../../supervisor/bg.js'
import { busProjections } from '../../supervisor/composition.js'
import { DRAIN_LIMIT_MS, DRAIN_WHY, GenerationHandover, INLINE_WORKERS, overdueInlineWorkers } from '../../supervisor/generation-handover.js'
import { signalLog } from '../../supervisor/signal-sent.js'
import { busDrain, BusSupervisor, freeLeasesOf, livesIn, withoutRetiring } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const OLD_GENERATION = 'a'.repeat(40)
const NEW_GENERATION = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const RETIRED_AT = Date.parse('2026-11-16T10:00:00.000Z')
const STARTED = new Date(RETIRED_AT - 60_000).toISOString()
const OLD_PID = 600
const NEW_PID = 701
const roots: string[] = []
const dbs: DatabaseSync[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'generation-handover-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  return db
}

const iso = (ms: number): string => new Date(ms).toISOString()

const actorOf = (node: string): string => `worker:${node}:old`

function startedWorker(db: DatabaseSync, node: string, pid: number): void {
  recordWorkerIdentity(db, STARTED, { worker: actorOf(node), pid, started: STARTED, instance: `${node}-old`, generation: OLD_GENERATION, pgid: pid, lstart: STARTED })
}

function inlineChild(db: DatabaseSync, node: string, pid: number, key: string): void {
  recordChildStarted(db, STARTED, actorOf(node), { mode: 'inline', instance: `${node}-old`, generation: OLD_GENERATION, pid, pgid: pid, lstart: STARTED, kind: node, taskKey: key, tree: null })
}

function retiring(db: DatabaseSync, node: string, pid: number): void {
  appendEvent(db, { ts: iso(RETIRED_AT), type: WORKER_RETIRING, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${WORKER_RETIRING}:${actorOf(node)}`, payload: { worker: actorOf(node), node, pids: [pid], sha: NEW_GENERATION, from: OLD_GENERATION }, legacy: false })
}

function living(...pids: number[]): ReturnType<typeof livesIn> {
  return livesIn(new InMemoryProcessTable({ rows: pids.map(pid => ({ pid, ppid: 1, pgid: pid, started: STARTED, command: 'node' })) }))
}

function retiredInline(db: DatabaseSync, node: string, pid: number): string {
  const key = `${node}:1:17:${'c'.repeat(40)}`
  startedWorker(db, node, pid)
  inlineChild(db, node, pid, key)
  retiring(db, node, pid)
  return key
}

function signalsSent(db: DatabaseSync): Record<string, unknown>[] {
  return new BusRead(db).slice(SIGNAL_SENT, ['pid', 'signal', 'why', 'task_key']).map(each => each.fields)
}

function handover(db: DatabaseSync, nowMs: number, lives: ReturnType<typeof livesIn>): { handover: GenerationHandover, stopped: RunningProcess[] } {
  const stopped: RunningProcess[] = []
  const stop = async (running: RunningProcess): Promise<void> => {
    stopped.push(running)
    signalLog(db, DRAIN_WHY, () => new Date(nowMs))(running.pid, 'SIGTERM')
  }
  return { handover: new GenerationHandover(db, lives, () => nowMs, stop), stopped }
}

describe('generation handover: the drain-limit stop of an inline worker', () => {
  it.each(INLINE_WORKERS.map(node => [node]))('an inline worker past the drain limit is stopped with signal.sent why drain (%s)', async (node) => {
    expect(INLINE_WORKERS).toEqual(['update', 'merge', 'close'])
    const db = bus()
    const key = retiredInline(db, node, OLD_PID)
    const { handover: step, stopped } = handover(db, RETIRED_AT + DRAIN_LIMIT_MS, living(OLD_PID))

    const lines = await step.step()

    expect(stopped).toEqual([{ pid: OLD_PID, args: actorOf(node) }])
    expect(signalsSent(db)).toEqual([{ pid: OLD_PID, signal: 'SIGTERM', why: DRAIN_WHY, task_key: key }])
    expect(lines).toEqual([`${PREFIX}the retiring worker pid ${OLD_PID} still ran its inline task ${DRAIN_LIMIT_MS / 60_000} min after it began to retire; stopped it with signal.sent why ${DRAIN_WHY}, and its lease is not freed as an expiry`])
    expect(new BusRead(db).slice(TASK_EXPIRED, ['task_key'])).toEqual([])
  })

  it('no stop below the drain limit, for a non-inline node or for a dead worker', async () => {
    const below = bus()
    retiredInline(below, 'update', OLD_PID)
    expect(overdueInlineWorkers(below, RETIRED_AT + DRAIN_LIMIT_MS - 1, living(OLD_PID)())).toEqual([])
    expect(overdueInlineWorkers(below, RETIRED_AT + DRAIN_LIMIT_MS, living(OLD_PID)())).toEqual([{ pid: OLD_PID, args: actorOf('update') }])
    const early = handover(below, RETIRED_AT + DRAIN_LIMIT_MS - 1, living(OLD_PID))
    await early.handover.step()
    expect(early.stopped).toEqual([])
    expect(signalsSent(below)).toEqual([])

    const other = bus()
    retiredInline(other, 'answer', OLD_PID)
    expect(overdueInlineWorkers(other, RETIRED_AT + 10 * DRAIN_LIMIT_MS, living(OLD_PID)())).toEqual([])
    const round = handover(other, RETIRED_AT + 10 * DRAIN_LIMIT_MS, living(OLD_PID))
    await round.handover.step()
    expect(round.stopped).toEqual([])
    expect(signalsSent(other)).toEqual([])

    const dead = bus()
    retiredInline(dead, 'merge', OLD_PID)
    expect(overdueInlineWorkers(dead, RETIRED_AT + DRAIN_LIMIT_MS, living()())).toEqual([])
    expect(overdueInlineWorkers(dead, RETIRED_AT + DRAIN_LIMIT_MS, null)).toEqual([])
    const gone = handover(dead, RETIRED_AT + DRAIN_LIMIT_MS, living())
    await gone.handover.step()
    expect(gone.stopped).toEqual([])
    expect(signalsSent(dead)).toEqual([])
  })

  it('the lease of an inline holder is not freed as task.expired at the drain limit', async () => {
    const db = bus()
    const clock = { now: 0 }
    const ts = (): string => iso(RETIRED_AT + clock.now)
    const head = 'c'.repeat(40)
    const [card, pr] = [1991, 17]
    appendEvent(db, { ts: ts(), type: PR_OBSERVED, actor: 'netwatch', cardId: card, pr, head, dedupeKey: `${PR_OBSERVED}:${pr}:${head}`, payload: { card_id: card, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
    reduce(db, 'pending', busProjections())
    const task = { queue: 'update', cardId: card, pr, head } as const
    queueTask(db, ts(), task)
    const key = taskKey(task)
    startedWorker(db, 'update', OLD_PID)
    expect(leaseNext(db, ts(), 'update', actorOf('update'))?.taskKey).toBe(key)
    inlineChild(db, 'update', OLD_PID, key)

    const { update } = workerLaunches(() => [])
    let alive: RunningProcess[] = [{ pid: OLD_PID, args: `node pnpm.cjs --silent ${launchName(update)}` }]
    const stopped: number[] = []
    let codeHead = OLD_GENERATION
    const processes = withoutRetiring(() => alive, db)
    const supervisor = new BusSupervisor({
      known: [update],
      wanted: () => [update],
      start: (launch: DetachedLaunch): BgResult => {
        alive = [...alive, { pid: NEW_PID, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
        return { stdout: [`${PREFIX}started`], stderr: [], exitCode: 0 }
      },
      stop: async (instance) => {
        stopped.push(instance.pid)
        alive = alive.filter(each => each.pid !== instance.pid)
      },
      freeLeases: list => freeLeasesOf(db, ts(), list),
      drain: busDrain(db, ts),
      processes,
      mainSince: () => [{ id: 1, sha: NEW_GENERATION }],
      code: {
        head: () => codeHead,
        holds: sha => sha === codeHead,
        pull: () => {
          codeHead = NEW_GENERATION
        },
        changedSince: sha => sha === codeHead ? [] : [SHARED_FILE],
        runs: () => new Set([SHARED_FILE]),
      },
      journal: () => {},
      now: () => RETIRED_AT + clock.now,
    }, 0)

    const retired = (await supervisor.step()).join('\n')
    expect(retired).toContain(`finishes the rounds it holds on ${OLD_GENERATION} and exits`)
    clock.now = DRAIN_LIMIT_MS
    const atLimit = (await supervisor.step()).join('\n')
    clock.now = DRAIN_LIMIT_MS + 60_000
    const pastLimit = (await supervisor.step()).join('\n')

    for (const lines of [retired, atLimit, pastLimit])
      expect(lines).not.toContain(TASK_EXPIRED)
    expect(stopped).toEqual([])
    expect(new BusRead(db).slice(TASK_EXPIRED, ['task_key'])).toEqual([])
    expect(db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key)).toEqual({ state: 'leased' })
    expect(new BusRead(db).slice(TASK_LEASED, ['task_key']).filter(each => each.fields.task_key === key).map(each => each.actor)).toEqual([actorOf('update')])

    const drained = handover(db, RETIRED_AT + DRAIN_LIMIT_MS, living(OLD_PID, NEW_PID))
    await drained.handover.step()
    expect(drained.stopped.map(each => each.pid)).toEqual([OLD_PID])
    expect(signalsSent(db)).toEqual([{ pid: OLD_PID, signal: 'SIGTERM', why: DRAIN_WHY, task_key: key }])
    expect(new BusRead(db).slice(TASK_EXPIRED, ['task_key'])).toEqual([])
  })
})
