import type { DatabaseSync as Bus } from 'node:sqlite'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { backup, DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchName } from '../../bus/bg.js'
import { appendEvent, BUSY_TIMEOUT_MS, openBus } from '../../bus/db.js'
import { leaseWhileFree } from '../../bus/lease.js'
import { CHECK_MS, NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { DATABASE_LOCKED, SWITCH_FLAG } from '../../bus/node.js'
import { reducedThrough } from '../../bus/reducer.js'
import { runRestartWorker } from '../../bus/restart-worker.js'
import { BusTick, tickOrLocked } from '../../bus/run.js'
import { recordWorkerDown, WorkerKeeper } from '../../bus/supervisor.js'
import { workerLaunches } from '../../bus/workers.js'
import { WORKER_DOWN } from '../../core/events.js'
import { Clock, FakeGitHub } from './github-fake.js'

const LIVE_BUS_COPY_VARIABLE = 'CONSTRUCT_BUS_COPY'
const GENERATED_PRS = 3000
const PENDING_EVENTS = 40
const USUAL_TICKS = 3
const NODE_WRITE_EVERY_MS = 20
const LOCK_HELD_AT_MOST_MS = 4 * BUSY_TIMEOUT_MS
const SHORT_WAIT_MS = 1000
const LOCKED_AT = '2026-10-22T12:00:00.000Z'
const HOLDS_THE_WRITE_LOCK = `
const { DatabaseSync } = require('node:sqlite')
const { workerData } = require('node:worker_threads')
const db = new DatabaseSync(workerData.file)
db.exec('BEGIN IMMEDIATE')
Atomics.store(workerData.signal, 0, 1)
Atomics.notify(workerData.signal, 0)
Atomics.wait(workerData.signal, 1, 0, workerData.holdMs)
db.exec('COMMIT')
db.close()
`
const WRITES_LIKE_A_NODE = `
const { DatabaseSync } = require('node:sqlite')
const { parentPort, workerData } = require('node:worker_threads')
const db = new DatabaseSync(workerData.file, { timeout: workerData.busyMs })
const insert = db.prepare("INSERT INTO events (ts, type, actor, dedupe_key, payload) VALUES (?, 'node.wrote', 'worker:launch:restart', ?, '{}')")
const errors = []
let writes = 0
Atomics.store(workerData.signal, 0, 1)
Atomics.notify(workerData.signal, 0)
while (Atomics.load(workerData.signal, 1) === 0) {
  try {
    db.exec('BEGIN IMMEDIATE')
    insert.run(new Date().toISOString(), 'node.wrote:' + process.pid + ':' + writes)
    db.exec('COMMIT')
    writes += 1
  }
  catch (error) {
    errors.push(String(error.message))
  }
  Atomics.wait(workerData.signal, 1, 0, workerData.everyMs)
}
db.close()
parentPort.postMessage({ writes, errors })
`

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function generatedHistory(file: string): void {
  const db = openBus(file)
  db.exec('BEGIN')
  for (let pr = 1; pr <= GENERATED_PRS; pr += 1) {
    const head = pr.toString(16).padStart(40, '0')
    appendEvent(db, { ts: LOCKED_AT, type: 'pr.observed', actor: 'netwatch', cardId: null, pr, head, dedupeKey: `pr.observed:generated:${pr}`, payload: { base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
    appendEvent(db, { ts: LOCKED_AT, type: 'pr.closed', actor: 'netwatch', cardId: null, pr, head: null, dedupeKey: `pr.closed:generated:${pr}`, payload: { merged: false }, legacy: false })
  }
  db.exec('COMMIT')
  db.close()
}

async function copyOfTheLiveBus(file: string): Promise<void> {
  const liveCopy = process.env[LIVE_BUS_COPY_VARIABLE]
  if (liveCopy === undefined || !existsSync(liveCopy)) {
    generatedHistory(file)
    return
  }
  const source = new DatabaseSync(liveCopy, { readOnly: true })
  try {
    await backup(source, file)
  }
  finally {
    source.close()
  }
  const copy = new DatabaseSync(file)
  expect(copy.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
  copy.close()
}

function nodeWritesWhileDown(db: Bus, round: number): void {
  for (let n = 0; n < PENDING_EVENTS; n += 1)
    appendEvent(db, { ts: LOCKED_AT, type: 'node.wrote', actor: 'worker:launch:restart', cardId: null, pr: null, head: null, dedupeKey: `node.wrote:pending:${round}:${n}`, payload: {}, legacy: false })
}

function busTickOn(db: Bus, clock: Clock): BusTick {
  return new BusTick(db, new NetWatch(db, new FakeGitHub().client, clock.now), clock.now)
}

function timedTick(busTick: BusTick, clock: Clock): number {
  clock.advance(TICK_MS)
  const started = performance.now()
  expect(busTick.run()).not.toBeNull()
  return performance.now() - started
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
}

function heldLock(file: string, holdMs: number): { release: () => void, released: Promise<unknown> } {
  const signal = new Int32Array(new SharedArrayBuffer(8))
  const holder = new Worker(HOLDS_THE_WRITE_LOCK, { eval: true, workerData: { file, signal, holdMs } })
  const released = once(holder, 'exit')
  expect(Atomics.wait(signal, 0, 0, 10_000)).not.toBe('timed-out')
  const release = (): void => {
    Atomics.store(signal, 1, 1)
    Atomics.notify(signal, 1)
  }
  return { release, released }
}

describe('a bus:run restart holds no write longer than a node waits', () => {
  it('a bus:run restart on a copy of the live bus.db keeps the first tick within twice a usual tick and no node log has database is locked', async () => {
    const file = scratch('bus-restart-first-tick-')
    await copyOfTheLiveBus(file)
    const clock = new Clock(Date.now())
    const before = openBus(file)
    const running = busTickOn(before, clock)
    timedTick(running, clock)
    const signal = new Int32Array(new SharedArrayBuffer(8))
    const node = new Worker(WRITES_LIKE_A_NODE, { eval: true, workerData: { file, signal, busyMs: BUSY_TIMEOUT_MS, everyMs: NODE_WRITE_EVERY_MS } })
    const nodeLog = once(node, 'message')
    expect(Atomics.wait(signal, 0, 0, 10_000)).not.toBe('timed-out')
    const usual: number[] = []
    for (let round = 0; round < USUAL_TICKS; round += 1) {
      nodeWritesWhileDown(before, round)
      usual.push(timedTick(running, clock))
    }
    nodeWritesWhileDown(before, USUAL_TICKS)
    before.close()

    const restarted = openBus(file)
    const first = timedTick(busTickOn(restarted, clock), clock)
    Atomics.store(signal, 1, 1)
    Atomics.notify(signal, 1)
    const [written] = await nodeLog as [{ writes: number, errors: string[] }]

    expect(reducedThrough(restarted)).toBeGreaterThan(0)
    expect(written.errors.filter(error => error.includes(DATABASE_LOCKED))).toEqual([])
    expect(first).toBeLessThanOrEqual(2 * median(usual))
    restarted.close()
  }, 10 * 60_000)

  it('a 30 s artificial write lock makes the nodes wait and continue, restart-worker stays alive and no worker.down is written', async () => {
    const file = scratch('bus-restart-locked-')
    const clock = new Clock(Date.parse(LOCKED_AT))
    const busDb = openBus(file)
    const busTick = busTickOn(busDb, clock)
    clock.advance(TICK_MS)
    expect(tickOrLocked(busTick)).not.toEqual([])
    const supervisorDb = openBus(file)
    const restart = workerLaunches(() => []).restart
    const journal: Record<string, unknown>[] = []
    const keeper = new WorkerKeeper({
      wanted: () => [restart],
      start: launch => ({ stdout: [`${launch.prefix}started`], stderr: [], exitCode: 0 }),
      processes: () => [{ pid: 1, args: `node pnpm.cjs --silent ${launchName(restart)} ${SWITCH_FLAG}` }],
      reduce: () => [],
      journal: entry => journal.push(entry),
      down: down => recordWorkerDown(supervisorDb, LOCKED_AT, down),
      now: () => 0,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const lock = heldLock(file, LOCK_HELD_AT_MOST_MS)

    busDb.exec(`PRAGMA busy_timeout = ${SHORT_WAIT_MS}`)
    clock.advance(TICK_MS)
    expect(tickOrLocked(busTick).join('\n')).toContain(DATABASE_LOCKED)

    const steps: number[] = []
    const stepLines: string[][] = []
    const restartLines = (): string[] => log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[bus:restart] '))
    const stopped = new Error('the test stops the restart worker')
    const restartWorker = runRestartWorker([SWITCH_FLAG], {
      busPath: file,
      processes: { commandLine: () => null, signalGroup: () => {} },
      launchSwitchedOn: () => false,
      session: 'locked',
      pause: async (ms) => {
        steps.push(ms)
        stepLines.push(restartLines())
        if (steps.length === 1) {
          expect(keeper.step()).toEqual([])
          lock.release()
          await lock.released
          return
        }
        throw stopped
      },
    })
    await expect(restartWorker).rejects.toBe(stopped)
    expect(steps).toEqual([CHECK_MS, CHECK_MS])
    expect(stepLines[0]!.at(-1)).toContain(DATABASE_LOCKED)
    expect(stepLines[1]!.filter(line => line.includes(DATABASE_LOCKED))).toHaveLength(1)

    clock.advance(TICK_MS)
    const afterLock = tickOrLocked(busTick)
    expect(afterLock.join('\n')).not.toContain(DATABASE_LOCKED)
    expect(afterLock.join('\n')).toContain('reduced')
    expect(leaseWhileFree(busDb, LOCKED_AT, { queue: 'merge', cardId: 1234 }, 'worker:merge:alive', 1)).not.toBeNull()
    expect(keeper.step()).toEqual([])
    expect(journal).toEqual([])
    expect(supervisorDb.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(WORKER_DOWN)).toEqual({ n: 0 })
    supervisorDb.close()
    busDb.close()
  }, LOCK_HELD_AT_MOST_MS * 2)
})
