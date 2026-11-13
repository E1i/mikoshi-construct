import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { BudgetLine } from '../core/eddies.js'
import type { Lease } from '../core/lease.js'
import type { ProcessTable } from '../ports/process-table.js'
import type { LeaseBeat } from './heartbeat.js'
import type { LifeOf, SessionLife } from './recorded-worker.js'
import { appendEvent } from '../core/db.js'
import { spendStopOf } from '../core/eddies.js'
import { messageOf } from '../core/errors.js'
import { CARD_SESSION_ENDED, CARD_STARTED, PR_OBSERVED, PR_OPENED, SESSION_HEARTBEAT, SESSION_STALLED, TASK_LEASED } from '../core/events.js'
import { failTask, releaseTask } from '../core/lease.js'
import { LEASED } from '../core/queue.js'
import { OsProcessTable } from '../ports/process-table.js'
import { beatsOfLease } from './heartbeat.js'
import { SILENT_MS } from './liveness-sites.js'
import { signal } from './supervisor.js'

export const STALLED_AFTER_MS = 30 * 60_000
export const REVIEW_STALLED_AFTER_MS = 8 * 60_000
export const STALLED_SWEEP_MS = 60_000
export const STALLED_ACTOR = 'worker:supervisor:stalled-sessions'
export const SESSION_STALLED_RELEASE = 'session_stalled'
export const REVIEW_STALLED_TWICE = 'review_stalled_twice'
export const STALE_SIGNALS_TO_STOP = 2
const REVIEW_ENDED_MARK = 'review-ended'

export type PulseOf = (session: string) => string | null

type Signal = 'context' | 'transcript' | 'process'

export type SpendOf = (lease: Lease, session: string) => BudgetLine | null

export type StopSession = (session: string) => void

type SupervisedQueue = 'answer' | 'launch' | 'review'

export const NO_PROGRESS_LINES: Readonly<Record<SupervisedQueue, number>> = { answer: STALLED_AFTER_MS, launch: STALLED_AFTER_MS, review: REVIEW_STALLED_AFTER_MS }

const EXPECTED_TO_PUSH: readonly SupervisedQueue[] = ['answer', 'launch']

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

const TRANSCRIPT_BEATS = `
  SELECT ts, json_extract(payload, '$.spent') AS spent, json_extract(payload, '$.subagents') AS subagents
  FROM events WHERE type = '${SESSION_HEARTBEAT}' AND legacy = 0 AND json_valid(payload)
    AND json_extract(payload, '$.task_key') = ? AND json_extract(payload, '$.lease_gen') = ?
  ORDER BY id
`

const REVIEW_ENDS_ON_HEAD = `
  SELECT coalesce(sum(json_extract(payload, '$.lease_gen') IS ?), 0) AS this_run, coalesce(sum(json_extract(payload, '$.lease_gen') IS NOT ?), 0) AS earlier_runs FROM events
  WHERE type = '${SESSION_STALLED}' AND legacy = 0 AND card_id = ? AND head IS ? AND dedupe_key LIKE '%:${REVIEW_ENDED_MARK}' AND json_valid(payload)
`

const CARD_TREE = `
  SELECT json_extract(payload, '$.worktree') AS worktree FROM events
  WHERE legacy = 0 AND type = '${CARD_STARTED}' AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.worktree') = 'text'
  ORDER BY id DESC LIMIT 1
`

interface LeasedRow {
  task_key: string
  queue: SupervisedQueue
  card_id: number
  pr: number | null
  head: string | null
  lease_gen: number
}

interface TranscriptBeat {
  ts: string
  spent: number | null
  subagents: string | null
}

interface Moved {
  readable: boolean
  at: string
}

interface Silence {
  lease: Lease
  queue: SupervisedQueue
  session: string | null
  since: string
  signals: Readonly<Record<Signal, Moved>>
}

export interface StalledSessionPorts {
  lifeOf: LifeOf
  stop?: StopSession
  spendOf?: SpendOf
  lines?: Readonly<Record<SupervisedQueue, number>>
  prefix?: string
  pulseOf?: PulseOf
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

export function transcriptMoved(leasedAt: string, beats: readonly TranscriptBeat[]): Moved {
  let mark: string | undefined
  let moved = leasedAt
  let readable = false
  for (const beat of beats) {
    if (typeof beat.spent !== 'number')
      continue
    readable = true
    const next = `${beat.spent}|${beat.subagents ?? ''}`
    if (next !== mark) {
      mark = next
      moved = beat.ts > moved ? beat.ts : moved
    }
  }
  return { readable, at: moved }
}

interface StalledPayload {
  session: string | null
  life: SessionLife
  since: string
  reason: string
}

function sessionPids(table: ProcessTable, session: string): number[] {
  const snapshot = table.snapshot()
  if (!snapshot.readable)
    return []
  return snapshot.rows.filter(row => row.command.split(/\s+/).includes(session)).map(row => row.pid)
}

function descendantsOf(rows: readonly { pid: number, ppid: number }[], roots: readonly number[]): number[] {
  const found = new Set(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.add(row.pid)
        grew = true
      }
    }
  }
  return [...found].sort((left, right) => left - right)
}

export function pulseIn(table: ProcessTable): PulseOf {
  return (session) => {
    const snapshot = table.snapshot()
    if (!snapshot.readable)
      return null
    const roots = snapshot.rows.filter(row => row.command.split(/\s+/).includes(session)).map(row => row.pid)
    return roots.length === 0 ? null : descendantsOf(snapshot.rows, roots).join(',')
  }
}

export function stopSessionIn(table: ProcessTable, end: (pid: number) => void = pid => signal(pid, 'SIGTERM')): StopSession {
  return (session) => {
    for (const pid of sessionPids(table, session))
      end(pid)
  }
}

export function spendInCardTree(db: DatabaseSync): SpendOf {
  return (lease, session) => {
    const tree = (db.prepare(CARD_TREE).get(lease.cardId) as { worktree: string } | undefined)?.worktree
    return tree === undefined ? null : spendStopOf(tree, session)
  }
}

export class StalledSessions {
  private lastSweep = Number.NEGATIVE_INFINITY
  private readonly lines: Readonly<Record<SupervisedQueue, number>>
  private readonly spendOf: SpendOf
  private readonly stop: StopSession
  private readonly prefix: string
  private readonly pulseOf: PulseOf
  private readonly pulses = new Map<string, { pulse: string, at: string }>()

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly ports: StalledSessionPorts) {
    this.lines = ports.lines ?? NO_PROGRESS_LINES
    this.spendOf = ports.spendOf ?? spendInCardTree(db)
    this.stop = ports.stop ?? stopSessionIn(new OsProcessTable())
    this.prefix = ports.prefix ?? ''
    this.pulseOf = ports.pulseOf ?? pulseIn(new OsProcessTable())
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
    const watched = new Set(rows.map(row => `${row.task_key}:${row.lease_gen}`))
    for (const key of this.pulses.keys()) {
      if (!watched.has(key))
        this.pulses.delete(key)
    }
    return rows.flatMap((row) => {
      const silence = this.silenceOf(row, nowMs)
      if (silence === null)
        return []
      const overSpend = this.overSpend(silence, nowMs)
      if (overSpend !== null)
        return overSpend
      if (nowMs - Date.parse(silence.since) < this.lines[silence.queue])
        return []
      return this.settle(silence, nowMs)
    })
  }

  private pulseMoved(key: string, session: string | null, nowMs: number): Moved {
    const now = new Date(nowMs).toISOString()
    const pulse = session === null ? null : this.pulseOf(session)
    if (pulse === null)
      return { readable: false, at: now }
    const seen = this.pulses.get(key)
    if (seen === undefined || seen.pulse !== pulse) {
      this.pulses.set(key, { pulse, at: now })
      return { readable: true, at: now }
    }
    return { readable: true, at: seen.at }
  }

  private silenceOf(row: LeasedRow, nowMs: number): Silence | null {
    const leased = this.db.prepare(LEASED_AT).get(`${TASK_LEASED}:${row.task_key}:${row.lease_gen}`) as { id: number, ts: string, actor: string } | undefined
    if (leased === undefined)
      return null
    const beats = beatsOfLease(this.db, { taskKey: row.task_key, leaseGen: Number(row.lease_gen) })
    const pushed = EXPECTED_TO_PUSH.includes(row.queue) ? (this.db.prepare(PUSHES_AFTER).get(row.card_id, leased.id) as { ts: string | null }).ts : null
    const lease: Lease = { taskKey: row.task_key, queue: row.queue, cardId: Number(row.card_id), pr: row.pr, head: row.head, leaseGen: Number(row.lease_gen), actor: leased.actor }
    const session = [...beats].reverse().find(beat => beat.session !== null)?.session ?? null
    const transcriptBeats = this.db.prepare(TRANSCRIPT_BEATS).all(row.task_key, Number(row.lease_gen)) as unknown as TranscriptBeat[]
    const signals: Record<Signal, Moved> = {
      context: { readable: session !== null, at: lastProgress(leased.ts, beats, pushed) },
      transcript: transcriptMoved(leased.ts, transcriptBeats),
      process: row.queue === 'review' ? this.pulseMoved(`${row.task_key}:${row.lease_gen}`, session, nowMs) : { readable: false, at: leased.ts },
    }
    const since = Object.values(signals).filter(signal => signal.readable).map(signal => signal.at).reduce((latest, at) => at > latest ? at : latest, signals.context.at)
    return { lease, queue: row.queue, session, since, signals }
  }

  private staleSignals(signals: Readonly<Record<Signal, Moved>>, queue: SupervisedQueue, nowMs: number): Signal[] {
    return (Object.keys(signals) as Signal[]).filter(name => signals[name].readable && nowMs - Date.parse(signals[name].at) >= this.lines[queue])
  }

  private overSpend({ lease, queue, session, since }: Silence, nowMs: number): string[] | null {
    if (session === null || !EXPECTED_TO_PUSH.includes(queue))
      return null
    const spend = this.spendOf(lease, session)
    if (spend === null)
      return null
    const life = this.lifeOf(session)
    if (life === 'dead')
      return null
    this.stop(session)
    const reason = `the ${queue} session ${session} of card #${lease.cardId} spent ${spend.spent} against the Eddies limit ${spend.limit} and was stopped`
    return this.raise(lease, nowMs, { session, life, since, reason }, `spend:${session}`)
  }

  private lifeOf(session: string | null): SessionLife {
    return session === null ? 'unknown' : this.ports.lifeOf(session)
  }

  private settle(silence: Silence, nowMs: number): string[] {
    const life = this.lifeOf(silence.session)
    if (silence.queue === 'review')
      return this.endReview(silence, life, nowMs)
    if (life === 'dead')
      return this.requeue(silence, nowMs)
    return this.raise(silence.lease, nowMs, { session: silence.session, life, since: silence.since, reason: this.silentReason(silence, life, this.minutesSince(silence.since, nowMs)) }, silence.since)
  }

  private minutesSince(since: string, nowMs: number): number {
    return Math.floor((nowMs - Date.parse(since)) / 60_000)
  }

  private endReview({ lease, session, since, signals }: Silence, life: SessionLife, nowMs: number): string[] {
    const minutes = this.minutesSince(since, nowMs)
    if (session === null || life !== 'live')
      return this.raise(lease, nowMs, { session, life, since, reason: `the review task ${lease.taskKey} of card #${lease.cardId} made no step and no output for ${minutes} min, and no live process names its session` }, since)
    const stale = this.staleSignals(signals, 'review', nowMs)
    if (stale.length < STALE_SIGNALS_TO_STOP)
      return this.raise(lease, nowMs, { session, life, since, reason: `the review session ${session} of card #${lease.cardId} is alive and only ${stale.join(', ') || 'no signal'} stood still for ${minutes} min; one stale signal stops nothing, the session runs on to its ceiling` }, since)
    const ends = this.db.prepare(REVIEW_ENDS_ON_HEAD).get(lease.leaseGen, lease.leaseGen, lease.cardId, lease.head) as { this_run: number, earlier_runs: number }
    if (ends.this_run > 0)
      return []
    if (ends.earlier_runs > 0)
      return this.endAgain({ lease, session, since, stale, minutes, life }, nowMs)
    this.stop(session)
    return this.raise(lease, nowMs, { session, life, since, reason: `the review session ${session} of card #${lease.cardId} made no step and no output: ${stale.join(', ')} stood still for ${minutes} min; it was ended before its ceiling` }, REVIEW_ENDED_MARK)
  }

  private endAgain({ lease, session, since, stale, minutes, life }: { lease: Lease, session: string, since: string, stale: Signal[], minutes: number, life: SessionLife }, nowMs: number): string[] {
    const ts = new Date(nowMs).toISOString()
    const reason = `the review of card #${lease.cardId} on head ${lease.head ?? 'none'} was ended by the stall line twice (${stale.join(', ')} stood still for ${minutes} min in session ${session}); it is not queued a third time the same way: ${lease.taskKey} is withdrawn as ${REVIEW_STALLED_TWICE} and waits for the window to review the diff by slices, file groups each under the review budget`
    failTask(this.db, ts, { ...lease, actor: STALLED_ACTOR }, { reason: REVIEW_STALLED_TWICE, withdraw: true }, SILENT_MS)
    this.stop(session)
    return this.raise(lease, nowMs, { session, life, since, reason }, REVIEW_ENDED_MARK)
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
