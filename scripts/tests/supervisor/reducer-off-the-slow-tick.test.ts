import type { DatabaseSync } from 'node:sqlite'
import type { Poll } from '../../ports/netwatch.js'
import type { ReducerLoopSpawn } from '../../supervisor/reducer-loop.js'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { factoryGraph } from '../../../tsup.config.js'
import { appendEvent, openBus, openBusWait } from '../../core/db.js'
import { CARD_FELL, REDUCED, REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { OWNER_WAITS } from '../../core/projection-types.js'
import { reducedThrough } from '../../core/reducer.js'
import { NetWatch } from '../../ports/netwatch.js'
import { busProjections } from '../../supervisor/composition.js'
import { lockedLine, REDUCER_LOOP_BUS_PATH, REDUCER_LOOP_HOME, REDUCER_LOOP_PERIOD, REDUCER_PASS_DONE, REDUCER_PERIOD_MS, REDUCER_PREFIX, REDUCER_THREAD, ReducerLoop, ReducerPass, reducerThreadBeside, startReducerLoop } from '../../supervisor/reducer-loop.js'
import { BusTick, TICK_STEPS, tickWhileReducing } from '../../supervisor/run.js'
import { requestFromWindow } from '../../window/window-requests.js'
import { Clock, FakeGitHub } from '../bus/github-fake.js'

const SLOW_TICK_MS = 60_000
const REDUCED_WITHIN_MS = 5_000
const ANSWERED_WITHIN_MS = REDUCER_PERIOD_MS + 1_000
const WORKER_READY_MS = 90_000
const HOLD_STEP_MS = 50
const QUIET_MS = 60_000

class NetWatchThatTicks extends NetWatch {
  override poll(): Poll {
    return { kind: 'ticked', reason: 'interval', calls: 0, remaining: null, written: 0, unsettled: [] }
  }
}

const opened: DatabaseSync[] = []
const dirs: string[] = []
const stops: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0))
    await stop()
  for (const db of opened.splice(0))
    db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function scratchBus(): { busPath: string, home: string, db: DatabaseSync } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reducer-off-the-slow-tick-'))
  dirs.push(dir)
  const busPath = path.join(dir, 'bus', 'bus.db')
  const db = openBus(busPath)
  opened.push(db)
  return { busPath, home: path.join(dir, 'home'), db }
}

function spawnWithTsx(spawned: Worker[]): ReducerLoopSpawn {
  return (entry, workerData) => {
    const worker = new Worker(entry, { workerData, execArgv: ['--import', 'tsx'] })
    spawned.push(worker)
    return worker
  }
}

function holdTheThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function slowTick(db: DatabaseSync, done: () => boolean): { tick: BusTick, heldMs: () => number } {
  let heldMs = SLOW_TICK_MS
  const clock = new Clock()
  const stalled = (): void => {
    const started = performance.now()
    while (performance.now() - started < SLOW_TICK_MS) {
      if (done()) {
        heldMs = performance.now() - started
        return
      }
      holdTheThread(HOLD_STEP_MS)
    }
  }
  return { tick: new BusTick(db, null, new NetWatchThatTicks(db, new FakeGitHub().client, clock.now), clock.now, () => {}, () => {}, stalled), heldMs: () => heldMs }
}

function lagOf(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE id > ? AND type != ?').get(reducedThrough(db), REDUCED) as { n: number }).n)
}

function reducedOnce(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM events WHERE type = ?').get(REDUCED) !== undefined
}

async function startedLoop(busPath: string, home: string, db: DatabaseSync): Promise<void> {
  const spawned: Worker[] = []
  const loop = startReducerLoop(busPath, home, REDUCER_PERIOD_MS, spawnWithTsx(spawned))
  stops.push(loop.stop)
  const [message] = await once(spawned[0]!, 'message') as unknown[]
  expect(message).toBe(REDUCER_PASS_DONE)
  expect(loop.failure()).toBeNull()
  expect(reducedOnce(db)).toBe(true)
}

describe('the reducer runs in its own thread, off the slow bus tick', () => {
  it('an appended event is reduced within 5 s while the tick takes 60 s', async () => {
    const { busPath, home, db } = scratchBus()
    await startedLoop(busPath, home, db)
    const wait = openBusWait(db, new Date().toISOString(), 'worker:test:reducer', { need: 'command', text: 'a wait the reducer folds', command: 'true' })
    const appended = Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
    expect(lagOf(db)).toBeGreaterThan(0)

    const { tick, heldMs } = slowTick(db, () => reducedThrough(db) >= appended && lagOf(db) === 0)
    expect(tick.run()?.steps.map(each => each.step)).toEqual([...TICK_STEPS])

    expect(heldMs()).toBeLessThan(REDUCED_WITHIN_MS)
    expect(lagOf(db)).toBe(0)
    expect(db.prepare(`SELECT id FROM ${OWNER_WAITS} WHERE id = ?`).get(wait)).toEqual({ id: wait })
  }, WORKER_READY_MS + SLOW_TICK_MS)

  it('a window request is answered within one reducer period, not one tick', async () => {
    const { busPath, home, db } = scratchBus()
    await startedLoop(busPath, home, db)
    const request = requestFromWindow(db, new Date().toISOString(), 'reducer-off-the-slow-tick', { kind: 'no.such.request' } as Parameters<typeof requestFromWindow>[3])
    const answer = db.prepare('SELECT type FROM events WHERE type IN (?, ?) AND json_extract(payload, \'$.request\') = ?')

    const { tick, heldMs } = slowTick(db, () => answer.get(REQUEST_DONE, REQUEST_REFUSED, request) !== undefined)
    tick.run()

    expect(heldMs()).toBeLessThan(ANSWERED_WITHIN_MS)
    expect(answer.get(REQUEST_DONE, REQUEST_REFUSED, request)).toEqual({ type: REQUEST_REFUSED })
  }, WORKER_READY_MS + SLOW_TICK_MS)
})

describe('the reducer pass and its loop', () => {
  it('a pass with nothing to reduce records no reducer.reduced until the quiet period has passed', () => {
    const { db } = scratchBus()
    const clock = new Clock()
    const pass = new ReducerPass(db, busProjections(), clock.now, () => {}, QUIET_MS)
    const reducedCount = (): number => Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(REDUCED) as { n: number }).n)
    pass.run()
    expect(reducedCount()).toBe(1)
    clock.advance(QUIET_MS / 2)
    pass.run()
    expect(reducedCount()).toBe(1)
    openBusWait(db, clock.now().toISOString(), 'worker:test:reducer', { need: 'command', text: 'folded', command: 'true' })
    expect(pass.run().applied).toBeGreaterThan(0)
    expect(reducedCount()).toBe(2)
    clock.advance(QUIET_MS)
    pass.run()
    expect(reducedCount()).toBe(3)
  })

  it('the reducer.reduced event keeps its shape: through_event_id, applied, rejected', () => {
    const { db } = scratchBus()
    const clock = new Clock()
    appendEvent(db, { ts: clock.now().toISOString(), type: CARD_FELL, actor: 'worker:test:reducer', cardId: null, pr: null, head: null, dedupeKey: 'fell', payload: { kind: 'r' }, legacy: false })
    new ReducerPass(db, busProjections(), clock.now).run()
    const row = db.prepare('SELECT payload FROM events WHERE type = ?').get(REDUCED) as { payload: string }
    expect(Object.keys(JSON.parse(row.payload)).sort()).toEqual(['applied', 'rejected', 'through_event_id'])
  })

  it('a locked database is retried on the next period and any other error ends the loop', () => {
    const locked = new ReducerLoop({ run: () => {
      throw new Error('database is locked')
    } }, 3_000)
    expect(locked.step()).toEqual([lockedLine(3_000)])
    expect(lockedLine(3_000)).toBe(`${REDUCER_PREFIX}the reducer pass hit database is locked; it is retried in 3 s`)
    const broken = new ReducerLoop({ run: () => {
      throw new Error('no such table')
    } })
    expect(() => broken.step()).toThrow(/no such table/)
  })

  it('a loop step prints nothing when the pass applied nothing', () => {
    expect(new ReducerLoop({ run: () => ({ applied: 0, rejected: 0 }) }).step()).toEqual([])
    expect(new ReducerLoop({ run: () => ({ applied: 2, rejected: 1 }) }).step()).toEqual([`${REDUCER_PREFIX}reduced: applied 2, rejected 1`])
  })

  it('the loop starts its worker with the bus path, the home and the period, and a worker error ends bus:run on its next tick', async () => {
    let started: { entry: URL, workerData: Record<string, unknown> } | null = null
    let fail: (error: Error) => void = () => {}
    const terminate = vi.fn(async () => 0)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loop = startReducerLoop('/bus/home/bus.db', '/home', 1234, (entry, workerData) => {
      started = { entry, workerData }
      return { on: (_event, listener) => {
        fail = listener
      }, terminate }
    })
    expect(started!.entry.pathname).toMatch(/reducer-thread\.ts$/)
    expect(started!.workerData).toEqual({ [REDUCER_LOOP_BUS_PATH]: '/bus/home/bus.db', [REDUCER_LOOP_HOME]: '/home', [REDUCER_LOOP_PERIOD]: 1234 })
    const { db } = scratchBus()
    const { tick } = slowTick(db, () => true)
    expect(tickWhileReducing(tick, loop)).toHaveLength(2)
    fail(new Error('the reducer broke\nstack'))
    expect(logged).toHaveBeenCalledWith(`${REDUCER_PREFIX}the reducer broke`)
    expect(() => tickWhileReducing(tick, loop)).toThrow(/the reducer thread ended \(the reducer broke\)/)
    await loop.stop()
    expect(terminate).toHaveBeenCalledOnce()
    logged.mockRestore()
  })

  it('the thread entry has the extension of the module that starts it, so the compiled package starts its .js', () => {
    expect(reducerThreadBeside('file:///pkg/dist/scripts/supervisor/reducer-loop.js').href).toBe('file:///pkg/dist/scripts/supervisor/reducer-thread.js')
    expect(reducerThreadBeside('file:///repo/scripts/supervisor/reducer-loop.ts').href).toBe('file:///repo/scripts/supervisor/reducer-thread.ts')
  })

  it('the factory build reaches the reducer thread', () => {
    expect(factoryGraph()).toContain(REDUCER_THREAD)
  })
})
