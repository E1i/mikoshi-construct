import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { Lease } from '../core/lease.js'
import type { LeaseBeat } from './heartbeat.js'
import type { LifeOf, SessionLife } from './recorded-worker.js'
import { appendEvent } from '../core/db.js'
import { messageOf } from '../core/errors.js'
import { CARD_SESSION_ENDED, PR_OBSERVED, PR_OPENED, SESSION_STALLED, TASK_LEASED } from '../core/events.js'
import { releaseTask } from '../core/lease.js'
import { LEASED } from '../core/queue.js'
import { beatsOfLease } from './heartbeat.js'

export const STALLED_AFTER_MS = 30 * 60_000
export const STALLED_SWEEP_MS = 60_000
export const STALLED_ACTOR = 'worker:supervisor:stalled-sessions'
export const SESSION_STALLED_RELEASE = 'session_stalled'

type SupervisedQueue = 'answer' | 'launch'

export const NO_PROGRESS_LINES: Readonly<Record<SupervisedQueue, number>> = { answer: STALLED_AFTER_MS, launch: STALLED_AFTER_MS }

const LEASED_SESSIONS = `
  SELECT task_key, queue, card_id, pr, head, lease_gen FROM tasks
  WHERE state = '${LEASED}' AND queue IN (${Object.keys(NO_PROGRESS_LINES).map(queue => `'${queue}'`).join(', ')})
  ORDER BY id
`

const LEASED_AT = `SELECT id, ts, actor FROM events WHERE type = '${TASK_LEASED}' AND dedupe_key = ?`

const PUSHES_AFTER = `
  SELECT max(first) AS ts FROM (
    SELECT min(ts) AS first FROM events WHERE card_id = ? AND id > ? AND legacy = 0 AND type IN ('${PR_OBSERVED}', '${PR_OPENED}') GROUP BY coalesce(head, type)
  )
`

interface LeasedRow {
  task_key: string
  queue: SupervisedQueue
  card_id: number
  pr: number | null
  head: string | null
  lease_gen: number
}

interface Silence {
  lease: Lease
  queue: SupervisedQueue
  session: string | null
  since: string
}

export interface StalledSessionPorts {
  lifeOf: LifeOf
  lines?: Readonly<Record<SupervisedQueue, number>>
  prefix?: string
}

export function lastProgress(leasedAt: string, beats: readonly LeaseBeat[], pushed: string | null): string {
  let context: number | null | undefined
  let moved = leasedAt
  for (const beat of beats) {
    if (beat.context !== context) {
      context = beat.context
      moved = beat.ts > moved ? beat.ts : moved
    }
  }
  return pushed !== null && pushed > moved ? pushed : moved
}

interface StalledPayload {
  session: string | null
  life: SessionLife
  since: string
  reason: string
}

export class StalledSessions {
  private lastSweep = Number.NEGATIVE_INFINITY
  private readonly lines: Readonly<Record<SupervisedQueue, number>>
  private readonly prefix: string

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly ports: StalledSessionPorts) {
    this.lines = ports.lines ?? NO_PROGRESS_LINES
    this.prefix = ports.prefix ?? ''
  }

  step(): string[] {
    const nowMs = this.clock().getTime()
    if (nowMs - this.lastSweep < STALLED_SWEEP_MS)
      return []
    this.lastSweep = nowMs
    try {
      return this.sweep(nowMs)
    }
    catch (error) {
      return [`${this.prefix}reading the silent card sessions failed: ${messageOf(error)}; retried on the next sweep`]
    }
  }

  private sweep(nowMs: number): string[] {
    const rows = this.db.prepare(LEASED_SESSIONS).all() as unknown as LeasedRow[]
    return rows.flatMap((row) => {
      const silence = this.silenceOf(row)
      if (silence === null)
        return []
      if (nowMs - Date.parse(silence.since) < this.lines[silence.queue])
        return []
      return this.settle(silence, nowMs)
    })
  }

  private silenceOf(row: LeasedRow): Silence | null {
    const leased = this.db.prepare(LEASED_AT).get(`${TASK_LEASED}:${row.task_key}:${row.lease_gen}`) as { id: number, ts: string, actor: string } | undefined
    if (leased === undefined)
      return null
    const beats = beatsOfLease(this.db, { taskKey: row.task_key, leaseGen: Number(row.lease_gen) })
    const pushed = (this.db.prepare(PUSHES_AFTER).get(row.card_id, leased.id) as { ts: string | null }).ts
    const lease: Lease = { taskKey: row.task_key, queue: row.queue, cardId: Number(row.card_id), pr: row.pr, head: row.head, leaseGen: Number(row.lease_gen), actor: leased.actor }
    return { lease, queue: row.queue, session: [...beats].reverse().find(beat => beat.session !== null)?.session ?? null, since: lastProgress(leased.ts, beats, pushed) }
  }

  private lifeOf(session: string | null): SessionLife {
    return session === null ? 'unknown' : this.ports.lifeOf(session)
  }

  private settle(silence: Silence, nowMs: number): string[] {
    const life = this.lifeOf(silence.session)
    if (life === 'dead')
      return this.requeue(silence, nowMs)
    return this.raise(silence.lease, nowMs, { session: silence.session, life, since: silence.since, reason: this.silentReason(silence, life, this.minutesSince(silence.since, nowMs)) }, silence.since)
  }

  private minutesSince(since: string, nowMs: number): number {
    return Math.floor((nowMs - Date.parse(since)) / 60_000)
  }

  private requeue({ lease, session, since }: Silence, nowMs: number): string[] {
    const ts = new Date(nowMs).toISOString()
    const detail = `the ${lease.queue} session ${session} of card #${lease.cardId} made no push and no new step for ${this.minutesSince(since, nowMs)} min and its process is gone`
    const ended: BusEvent = { ts, type: CARD_SESSION_ENDED, actor: STALLED_ACTOR, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_SESSION_ENDED}:stalled:${lease.taskKey}:${lease.leaseGen}`, payload: { session, stopped: true, detail }, legacy: false }
    releaseTask(this.db, ts, { ...lease, actor: STALLED_ACTOR }, SESSION_STALLED_RELEASE, [ended])
    return [`${this.prefix}${CARD_SESSION_ENDED} #${lease.cardId}: ${detail}; ${lease.taskKey} is queued again`]
  }

  private silentReason({ lease, session }: Silence, life: SessionLife, minutes: number): string {
    if (session === null)
      return `the ${lease.queue} task ${lease.taskKey} of card #${lease.cardId} made no push and no new step for ${minutes} min, and no heartbeat names its session, so the bus cannot tell whether it lives`
    return life === 'live'
      ? `the ${lease.queue} session ${session} of card #${lease.cardId} is alive but made no push and no new step for ${minutes} min`
      : `the ${lease.queue} session ${session} of card #${lease.cardId} made no push and no new step for ${minutes} min, and the process table could not be read`
  }

  private raise(lease: Lease, nowMs: number, payload: StalledPayload, mark: string): string[] {
    const ts = new Date(nowMs).toISOString()
    const raised = appendEvent(this.db, { ts, type: SESSION_STALLED, actor: STALLED_ACTOR, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${SESSION_STALLED}:${lease.taskKey}:${lease.leaseGen}:${mark}`, payload: { task_key: lease.taskKey, lease_gen: lease.leaseGen, queue: lease.queue, ...payload }, legacy: false })
    return raised ? [`${this.prefix}${SESSION_STALLED} #${lease.cardId}: ${payload.reason}`] : []
  }
}
