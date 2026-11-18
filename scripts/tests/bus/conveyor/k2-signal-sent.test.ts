import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import type { ChildRun } from '../../../core/node.js'
import type { RunningProcess } from '../../../supervisor/bg.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../../core/db.js'
import { CHILD_ENDED, CHILD_STARTED, SIGNAL_SENT, TASK_FAILED, TASK_RELEASED } from '../../../core/events.js'
import { leaseWhileFree, openDrain, RESTART_CUT } from '../../../core/lease.js'
import { ChildLog, INSTANCE_VARIABLE } from '../../../core/node.js'
import { QUEUED } from '../../../core/queue.js'
import { spawnClient } from '../../../nodes/answer/duties/client.js'
import { AnswerOutcomes } from '../../../nodes/answer/duties/outcomes.js'
import { BusRead } from '../../../ports/bus-read.js'
import { OsProcessTable } from '../../../ports/process-table.js'
import { cardTransitions } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { tableIdentity } from '../../../supervisor/recorded-worker.js'
import { RESTART_WHY, signalLog } from '../../../supervisor/signal-sent.js'
import { stopInstance } from '../../../supervisor/supervisor.js'

const CARD = 1908
const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const WORKER_ACTOR = 'worker:answer:k2'
const INSTANCE = 'k2-old'
const SESSION_LIFE_MS = 60_000

const WORKER = `
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => {})
const session = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${SESSION_LIFE_MS})'], { stdio: 'ignore' })
process.stdout.write(String(session.pid) + '\\n')
session.on('close', (code, signal) => {
  process.stdout.write(JSON.stringify({ code, signal }) + '\\n', () => process.exit(0))
})
`

const table = new OsProcessTable()
const spawned: ChildProcess[] = []
const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    }
    catch {}
  }
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

interface Ended {
  code: number | null
  signal: NodeJS.Signals | null
}

interface Bench {
  db: DatabaseSync
  lease: Lease
  worker: ChildProcess
  session: number
  run: ChildRun
  log: ChildLog
  sessionEnded: Promise<Ended>
  workerExited: Promise<unknown>
  outcomes: AnswerOutcomes
}

async function benchWithALiveSession(): Promise<Bench> {
  const root = mkdtempSync(path.join(tmpdir(), 'k2-signal-sent-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const ts = (): string => new Date().toISOString()
  const lease = leaseWhileFree(db, ts(), { queue: 'answer', cardId: CARD }, WORKER_ACTOR, 2)!
  const worker = spawn(process.execPath, ['-e', WORKER], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  spawned.push(worker)
  const lines = createInterface({ input: worker.stdout! })[Symbol.asyncIterator]()
  const next = async (): Promise<string> => {
    const line = await lines.next()
    if (line.done === true)
      throw new Error(`worker ${worker.pid} closed its output before the line the test awaits`)
    return line.value
  }
  const session = Number(await next())
  const run: ChildRun = { actor: WORKER_ACTOR, taskKey: lease.taskKey, kind: 'answer', tree: root }
  const log = new ChildLog(write => write(db), tableIdentity(table), () => new Date(), { [INSTANCE_VARIABLE]: INSTANCE })
  expect(log.started(run, session), 'the session has its row in the process table').toBe(true)
  openDrain(db, ts(), NEW_MAIN, new Date(Date.now() + 60_000).toISOString(), 'answer', OLD_MAIN)
  const sessionEnded = (async (): Promise<Ended> => {
    const ended = JSON.parse(await next()) as Ended
    log.ended(run, session, ended.code, ended.signal)
    return ended
  })()
  const outcomes = new AnswerOutcomes({ silentMs: SILENT_MS, db, cards: cardTransitions(), clock: () => new Date(), ownerMerges: () => '' }, { pathsIn: () => [], ownerBoundary: () => undefined, wideningAsked: () => [] })
  const workerExited = new Promise(resolve => worker.once('exit', resolve))
  return { db, lease, worker, session, run, log, sessionEnded, workerExited, outcomes }
}

function answerFailed(bench: Bench, ended: Ended): ReturnType<AnswerOutcomes['denied']> {
  return bench.outcomes.denied(bench.lease, { kind: 'technical', reason: 'answer_failed', detail: `the session exited ${ended.code ?? ended.signal}` })
}

describe('k2: an answer session records the signal that ended it', () => {
  it('a session spawned by spawnClient and killed by SIGKILL is recorded as exit by signal 9, not as exit 1', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'k2-answer-signal-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    const log = new ChildLog(write => write(db), pid => ({ pid, pgid: pid, lstart: 'Mon Nov 16 10:00:00 2026' }), () => new Date(), { [INSTANCE_VARIABLE]: INSTANCE })
    const run: ChildRun = { actor: WORKER_ACTOR, taskKey: 'answer:1908:1:h', kind: 'answer', tree: root }
    const code = await log.around(run, async started => spawnClient({ cwd: root, command: 'sh', argv: ['-c', 'kill -9 $$'], stdoutPath: path.join(root, 'out.log'), stderrPath: path.join(root, 'err.log'), env: process.env, started }))
    expect(code).toBe(1)
    expect(new BusRead(db).slice(CHILD_ENDED, ['exit', 'signal', 'task_key']).map(each => each.fields)).toEqual([{ exit: null, signal: 'SIGKILL', task_key: run.taskKey }])
  }, 30_000)

  it('a session that exits on its own keeps its exit code and no signal', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'k2-answer-exit-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    const log = new ChildLog(write => write(db), pid => ({ pid, pgid: pid, lstart: 'Mon Nov 16 10:00:00 2026' }), () => new Date(), { [INSTANCE_VARIABLE]: INSTANCE })
    const run: ChildRun = { actor: WORKER_ACTOR, taskKey: 'answer:1908:2:h', kind: 'answer', tree: root }
    expect(await log.around(run, async started => spawnClient({ cwd: root, command: 'sh', argv: ['-c', 'exit 3'], stdoutPath: path.join(root, 'out.log'), stderrPath: path.join(root, 'err.log'), env: process.env, started }))).toBe(3)
    expect(new BusRead(db).slice(CHILD_ENDED, ['exit', 'signal']).map(each => each.fields)).toEqual([{ exit: 3, signal: null }])
  }, 30_000)
})

describe('k2 [needs ps]: scenario 04, exit by an outside signal is not restart_cut', () => {
  it('scenario 04: a session SIGKILLed from outside the bus is recorded as exit by signal 9 with no signal.sent and labelled answer_failed', async () => {
    const bench = await benchWithALiveSession()
    process.kill(bench.session, 'SIGKILL')
    const ended = await bench.sessionEnded
    expect(ended).toEqual({ code: null, signal: 'SIGKILL' })
    expect(alive(bench.session)).toBe(false)
    const read = new BusRead(bench.db)
    expect(read.slice(CHILD_ENDED, ['pid', 'exit', 'signal', 'task_key']).map(each => each.fields)).toEqual([{ pid: bench.session, exit: null, signal: 'SIGKILL', task_key: bench.lease.taskKey }])
    expect(read.slice(SIGNAL_SENT, ['pid', 'lstart'])).toEqual([])

    const outcome = answerFailed(bench, ended)

    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' }, next: QUEUED })
    expect(read.slice(TASK_FAILED, ['task_key', 'reason']).map(each => each.fields)).toEqual([{ task_key: bench.lease.taskKey, reason: 'answer_failed' }])
    expect(read.slice(TASK_RELEASED, ['reason']).map(each => each.fields)).not.toContainEqual({ reason: RESTART_CUT })
  }, 30_000)

  it('scenario 04: a stop the bus sends is recorded signal.sent first and only then labelled restart_cut', async () => {
    const bench = await benchWithALiveSession()
    const [child] = new BusRead(bench.db).slice(CHILD_STARTED, ['pid', 'pgid', 'lstart'])
    expect(child?.fields).toMatchObject({ pid: bench.session, pgid: bench.worker.pid })
    const lstart = child!.fields.lstart
    const running: RunningProcess = { pid: bench.worker.pid!, args: `node -e worker` }
    await stopInstance(running, () => alive(running.pid) ? [running] : [], async () => bench.workerExited, signalLog(bench.db, RESTART_WHY))
    const ended = await bench.sessionEnded
    expect(ended).toEqual({ code: null, signal: 'SIGTERM' })
    expect(alive(bench.session)).toBe(false)

    const outcome = answerFailed(bench, ended)

    const read = new BusRead(bench.db)
    const [sent] = read.slice(SIGNAL_SENT, ['pid', 'lstart', 'signal', 'why', 'task_key', 'instance'])
    const [childEnded] = read.slice(CHILD_ENDED, ['pid', 'signal'])
    const [released] = read.slice(TASK_RELEASED, ['reason', 'task_key'])
    expect(sent?.fields).toEqual({ pid: bench.session, lstart, signal: 'SIGTERM', why: RESTART_WHY, task_key: bench.lease.taskKey, instance: INSTANCE })
    expect(childEnded?.fields).toEqual({ pid: bench.session, signal: 'SIGTERM' })
    expect(released?.fields).toEqual({ reason: RESTART_CUT, task_key: bench.lease.taskKey })
    expect(sent!.id).toBeLessThan(childEnded!.id)
    expect(childEnded!.id).toBeLessThan(released!.id)
    expect(outcome).toMatchObject({ kind: 'denied', next: QUEUED })
    expect(read.slice(TASK_FAILED, ['reason'])).toEqual([])
  }, 30_000)

  it('scenario 04: a restart since the lease with no signal.sent naming its child is no restart_cut', async () => {
    const bench = await benchWithALiveSession()
    process.kill(bench.session, 'SIGTERM')
    const ended = await bench.sessionEnded
    expect(answerFailed(bench, ended)).toMatchObject({ denial: { reason: 'answer_failed' } })
    expect(new BusRead(bench.db).slice(TASK_RELEASED, ['reason']).map(each => each.fields)).not.toContainEqual({ reason: RESTART_CUT })
  }, 30_000)
})
