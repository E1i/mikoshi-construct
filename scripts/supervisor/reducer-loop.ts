import type { DatabaseSync } from 'node:sqlite'
import type { Projections, ReduceCount } from '../core/reducer.js'
import process from 'node:process'
import { Worker } from 'node:worker_threads'
import { appendEvent } from '../core/db.js'
import { REDUCED, WINDOW_REQUEST } from '../core/events.js'
import { DATABASE_LOCKED, isDatabaseLocked } from '../core/node.js'
import { reduce } from '../core/reducer.js'
import { ownerChannelOfBus } from '../owner/channel.js'
import { TICK_MS } from '../ports/netwatch.js'
import { realRequestTools } from '../window/window-request-tools.js'
import { WindowRequests } from '../window/window-requests.js'
import { busProjections } from './composition.js'

export const REDUCER_PERIOD_MS = 2_000
export const REDUCER_PREFIX = '[bus:reducer] '
export const REDUCER_LOOP_BUS_PATH = 'reducerLoopBusPath'
export const REDUCER_LOOP_PERIOD = 'reducerLoopPeriodMs'
export const REDUCER_LOOP_HOME = 'reducerLoopHome'
export const REDUCER_PASS_DONE = 'reducer.pass.done'
export const QUIET_REDUCED_MS = TICK_MS
const REDUCER_LOOP_ENTRY = new URL('./reducer-loop-worker.ts', import.meta.url)

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

export function composeReducerPass(db: DatabaseSync, busPath: string, clock: () => Date, home: string, repo: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log, quietMs: number = QUIET_REDUCED_MS): ReducerPass {
  const projections = busProjections()
  const requests = new WindowRequests(db, clock, realRequestTools(db, busPath, repo, env, projections), ownerChannelOfBus(home, busPath))
  const answer = (): void => {
    for (const outcome of requests.run())
      log(`${REDUCER_PREFIX}${WINDOW_REQUEST} ${outcome.request} ${outcome.kind}: ${outcome.detail}`)
  }
  return new ReducerPass(db, projections, clock, answer, quietMs)
}

export interface StartedReducerLoop {
  failure: () => Error | null
  stop: () => Promise<void>
}

export type ReducerLoopSpawn = (entry: URL, workerData: Record<string, unknown>) => { on: (event: 'error', listener: (error: Error) => void) => unknown, terminate: () => Promise<unknown> }

export function startReducerLoop(busPath: string, home: string, periodMs: number = REDUCER_PERIOD_MS, spawn: ReducerLoopSpawn = (entry, workerData) => new Worker(entry, { workerData })): StartedReducerLoop {
  let failed: Error | null = null
  const worker = spawn(REDUCER_LOOP_ENTRY, { [REDUCER_LOOP_BUS_PATH]: busPath, [REDUCER_LOOP_PERIOD]: periodMs, [REDUCER_LOOP_HOME]: home })
  worker.on('error', (error) => {
    failed = error
    console.error(`${REDUCER_PREFIX}${error.message.split('\n')[0]}`)
  })
  return {
    failure: () => failed,
    stop: async () => void await worker.terminate(),
  }
}
