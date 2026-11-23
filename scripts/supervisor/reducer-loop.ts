import type { DatabaseSync } from 'node:sqlite'
import type { Projections, ReduceCount } from '../core/reducer.js'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { builtEntry } from '../core/built-entry.js'
import { appendEvent } from '../core/db.js'
import { REDUCED } from '../core/events.js'
import { DATABASE_LOCKED, isDatabaseLocked } from '../core/node.js'
import { reduce } from '../core/reducer.js'

export const REDUCER_PERIOD_MS = 2_000
export const REDUCER_PREFIX = '[bus:reducer] '
export const REDUCER_LOOP_BUS_PATH = 'reducerLoopBusPath'
export const REDUCER_LOOP_PERIOD = 'reducerLoopPeriodMs'
export const REDUCER_LOOP_HOME = 'reducerLoopHome'
export const REDUCER_PASS_DONE = 'reducer.pass.done'
export const REDUCER_THREAD = 'scripts/supervisor/reducer-thread.ts'

export function reducerThreadBeside(module: string): URL {
  return builtEntry(new URL(`./${path.posix.basename(REDUCER_THREAD)}`, module), module).url
}

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

export class ReducerPass {
  private lastReducedMs: number | null = null

  constructor(private readonly db: DatabaseSync, private readonly projections: Projections, private readonly clock: () => Date, private readonly requests: () => void = () => {}, private readonly quietMs: number = 0) {}

  run(): ReduceCount {
    const beforeRequests = reduce(this.db, 'pending', this.projections)
    this.requests()
    const now = this.clock()
    const through = lastEventId(this.db)
    const afterRequests = reduce(this.db, 'pending', this.projections)
    const both = { applied: beforeRequests.applied + afterRequests.applied, rejected: beforeRequests.rejected + afterRequests.rejected }
    if (this.recordsReduced(both, now.getTime())) {
      const ts = now.toISOString()
      appendEvent(this.db, { ts, type: REDUCED, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: `${REDUCED}:${ts}`, payload: { through_event_id: through, ...both }, legacy: false })
      this.lastReducedMs = now.getTime()
    }
    return both
  }

  private recordsReduced(count: ReduceCount, nowMs: number): boolean {
    if (count.applied + count.rejected > 0 || this.lastReducedMs === null)
      return true
    return nowMs - this.lastReducedMs >= this.quietMs
  }
}

export function reducedLine(count: ReduceCount): string {
  return `${REDUCER_PREFIX}reduced: applied ${count.applied}, rejected ${count.rejected}`
}

export function lockedLine(periodMs: number): string {
  return `${REDUCER_PREFIX}the reducer pass hit ${DATABASE_LOCKED}; it is retried in ${periodMs / 1000} s`
}

export class ReducerLoop {
  constructor(private readonly pass: { run: () => ReduceCount }, private readonly periodMs: number = REDUCER_PERIOD_MS) {}

  step(): string[] {
    try {
      const count = this.pass.run()
      return count.applied + count.rejected > 0 ? [reducedLine(count)] : []
    }
    catch (error) {
      if (!isDatabaseLocked(error))
        throw error
      return [lockedLine(this.periodMs)]
    }
  }
}

export interface StartedReducerLoop {
  failure: () => Error | null
  stop: () => Promise<void>
}

export type ReducerLoopSpawn = (entry: URL, workerData: Record<string, unknown>) => { on: (event: 'error', listener: (error: Error) => void) => unknown, terminate: () => Promise<unknown> }

export function startReducerLoop(busPath: string, home: string, periodMs: number = REDUCER_PERIOD_MS, spawn: ReducerLoopSpawn = (entry, workerData) => new Worker(entry, { workerData })): StartedReducerLoop {
  let failed: Error | null = null
  const worker = spawn(reducerThreadBeside(import.meta.url), { [REDUCER_LOOP_BUS_PATH]: busPath, [REDUCER_LOOP_PERIOD]: periodMs, [REDUCER_LOOP_HOME]: home })
  worker.on('error', (error) => {
    failed = error
    console.error(`${REDUCER_PREFIX}${error.message.split('\n')[0]}`)
  })
  return {
    failure: () => failed,
    stop: async () => void await worker.terminate(),
  }
}
