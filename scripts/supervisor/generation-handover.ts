import type { DatabaseSync } from 'node:sqlite'
import type { HolderReading } from '../core/lease.js'
import type { RunningProcess } from './bg.js'
import { appendEvent } from '../core/db.js'
import { GENERATION_ENDED, RESTARTED, TASK_EXPIRED, WORKER_RETIRING, WORKER_STARTED } from '../core/events.js'
import { HOLDER_DEAD, HOLDER_UNPROVEN, LEASE_MS, WORKER_HUNG } from '../core/lease.js'
import { matchingEvents, UNHANDED } from '../core/node.js'
import { QUEUE_ACTOR } from '../core/queue.js'
import { payloadOf } from '../core/stored.js'
import { PREFIX } from './bg.js'
import { childrenNotEnded, recordedWorkers } from './recorded-worker.js'
import { ROUND_WORKERS } from './workers.js'

export const DRAIN_LIMIT_MS = LEASE_MS
export const DRAIN_WHY = 'drain'
export const INLINE_WORKERS: readonly string[] = ['update', 'merge', 'close']
export const RETIRING_WORKERS: readonly string[] = [...ROUND_WORKERS, ...INLINE_WORKERS]

export type Lives = (recorded: { pid: number, lstart: string }) => boolean

export type LivesNow = () => Lives | null

const EVERY_EVENT = Number.MAX_SAFE_INTEGER

export function recordRestarted(db: DatabaseSync, ts: string, sha: string): void {
  appendEvent(db, { ts, type: RESTARTED, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${RESTARTED}:${sha}`, payload: { sha }, legacy: false })
}

export function holderLines(reading: HolderReading): string[] {
  return [
    ...reading.freed.length === 0 ? [] : [`${PREFIX}the holder process of these leases is gone or its pid now runs another process; freed as ${TASK_EXPIRED} (${HOLDER_DEAD}) and queued again: ${reading.freed.join(', ')}`],
    ...reading.hung.length === 0 ? [] : [`${PREFIX}the holder of these leases is running and has stopped renewing them; the leases stay, ${WORKER_HUNG} is on the board: ${reading.hung.join(', ')}`],
    ...reading.unproven.length === 0 ? [] : [`${PREFIX}the holder of these leases has no readable worker.started record, so whether it is alive cannot be proven; the leases stay, ${HOLDER_UNPROVEN} is on the board: ${reading.unproven.join(', ')}`],
  ]
}

function recorded(db: DatabaseSync, type: string): { ts: string, payload: Record<string, unknown> }[] {
  return matchingEvents(db, [type], 0, EVERY_EVENT).flatMap((event) => {
    try {
      return [{ ts: event.ts, payload: payloadOf(event) }]
    }
    catch {
      return []
    }
  })
}

function currentGeneration(db: DatabaseSync): string | null {
  const handed = recorded(db, WORKER_STARTED).map(each => each.payload.generation).filter(generation => typeof generation === 'string' && generation !== UNHANDED)
  return (handed.at(-1) as string | undefined) ?? null
}

export function generationsEnded(db: DatabaseSync, ts: string, lives: Lives | null): string[] {
  if (lives === null)
    return []
  const current = currentGeneration(db)
  const ended = new Set(recorded(db, GENERATION_ENDED).map(each => each.payload.generation))
  const processes = [...recordedWorkers(db), ...childrenNotEnded(db)]
  const living = new Set(processes.filter(lives).map(each => each.generation))
  const over = [...new Set(processes.map(each => each.generation))].filter(generation => generation !== current && generation !== UNHANDED && !ended.has(generation) && !living.has(generation))
  for (const generation of over)
    appendEvent(db, { ts, type: GENERATION_ENDED, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${GENERATION_ENDED}:${generation}`, payload: { generation }, legacy: false })
  return over
}

export function overdueInlineWorkers(db: DatabaseSync, nowMs: number, lives: Lives | null): RunningProcess[] {
  if (lives === null)
    return []
  const workers = new Map(recordedWorkers(db).map(worker => [worker.worker, worker]))
  return recorded(db, WORKER_RETIRING).flatMap(({ ts, payload }) => {
    const worker = workers.get(String(payload.worker))
    const overdue = INLINE_WORKERS.includes(String(payload.node)) && nowMs - Date.parse(ts) >= DRAIN_LIMIT_MS
    return overdue && worker !== undefined && lives(worker) ? [{ pid: worker.pid, args: worker.worker }] : []
  })
}

export class GenerationHandover {
  constructor(private readonly db: DatabaseSync, private readonly livesNow: LivesNow, private readonly now: () => number, private readonly stop: (running: RunningProcess) => Promise<void>) {}

  async step(): Promise<string[]> {
    const lines: string[] = []
    for (const running of overdueInlineWorkers(this.db, this.now(), this.livesNow())) {
      await this.stop(running)
      lines.push(`${PREFIX}the retiring worker pid ${running.pid} still ran its inline task ${DRAIN_LIMIT_MS / 60_000} min after it began to retire; stopped it with signal.sent why ${DRAIN_WHY}, and its lease is not freed as an expiry`)
    }
    const ended = generationsEnded(this.db, new Date(this.now()).toISOString(), this.livesNow())
    return [...lines, ...ended.map(generation => `${PREFIX}every process registered under generation ${generation} has ended; ${GENERATION_ENDED} is recorded as its summary`)]
  }
}
