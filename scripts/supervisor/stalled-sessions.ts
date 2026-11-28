import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { BudgetLine } from '../core/eddies.js'
import type { EventRow } from '../core/events-query.js'
import type { CardTransitions, Lease } from '../core/lease.js'
import type { GitRunner } from '../ports/git.js'
import type { ProcessTable } from '../ports/process-table.js'
import type { ActionOf, LeasedRound, UnendedStart } from './expected-time.js'
import type { LeaseBeat } from './heartbeat.js'
import type { LifeOf, SessionLife } from './recorded-worker.js'
import path from 'node:path'
import { appendEvent } from '../core/db.js'
import { spendStopOf } from '../core/eddies.js'
import { messageOf } from '../core/errors.js'
import { EITHER_JOURNAL, events } from '../core/events-query.js'
import { BOARD_ALARM, CARD_SESSION_ENDED, CARD_STARTED, PR_OBSERVED, PR_OPENED, SESSION_STALLED, TASK_LEASED } from '../core/events.js'
import { releaseTask } from '../core/lease.js'
import { LEASED } from '../core/queue.js'
import { all as allTasks } from '../core/tasks-query.js'
import { processGit } from '../ports/git.js'
import { OsProcessTable } from '../ports/process-table.js'
import { firstPushAfter, firstReleaseAfter, RoundOverTime, unendedStarts } from './expected-time.js'
import { beatsOfLease, heartbeatsOfLease } from './heartbeat.js'
import { transcriptActionIn } from './session-view.js'
import { signal } from './signal-sent.js'

export const STALLED_AFTER_MS = 30 * 60_000
export const REVIEW_STALLED_AFTER_MS = 8 * 60_000
export const STALLED_SWEEP_MS = 60_000
export const STALLED_ACTOR = 'worker:supervisor:stalled-sessions'
export const SESSION_STALLED_RELEASE = 'session_stalled'
export const REVIEW_STALLED_TWICE = 'review_stalled_twice'
export const STALE_SIGNALS_TO_STOP = 2
const REVIEW_ENDED_MARK = 'review-ended'
const REVIEW_STALL_MARK = 'review-stalled'
export const REVIEW_RUNS_ON = 'the session runs on and is not stopped: no stall line and no ceiling ends a review session, it runs until it exits'

export type PulseOf = (session: string) => string | null

type Signal = 'context' | 'transcript' | 'process'

export type SpendOf = (lease: Lease, session: string) => BudgetLine | null

export type StopSession = (session: string) => void

export type SaveTree = (lease: Lease, session: string) => string

type SupervisedQueue = 'answer' | 'launch' | 'review'

export const NO_PROGRESS_LINES: Readonly<Record<SupervisedQueue, number>> = { answer: STALLED_AFTER_MS, launch: STALLED_AFTER_MS, review: REVIEW_STALLED_AFTER_MS }

const EXPECTED_TO_PUSH: readonly SupervisedQueue[] = ['answer', 'launch']

const SUPERVISED_QUEUES: readonly string[] = Object.keys(NO_PROGRESS_LINES)

function leasedSessions(db: DatabaseSync): LeasedRow[] {
  return allTasks(db).filter(task => task.state === LEASED && SUPERVISED_QUEUES.includes(task.queue)).sort((a, b) => a.id - b.id).map(task => ({ ...task, queue: task.queue as SupervisedQueue }))
}

function leasedAt(db: DatabaseSync, row: LeasedRow): EventRow | null {
  return events(db, { keys: [`${TASK_LEASED}:${row.task_key}:${row.lease_gen}`], types: [TASK_LEASED], legacy: EITHER_JOURNAL })[0] ?? null
}

function pushedAfter(db: DatabaseSync, cardId: number, leasedId: number): string | null {
  const firstOfEach = new Map<string, string>()
  for (const push of events(db, { card: cardId, since: leasedId, types: [PR_OBSERVED, PR_OPENED] })) {
    const key = push.head ?? push.type
    const first = firstOfEach.get(key)
    if (first === undefined || push.ts < first)
      firstOfEach.set(key, push.ts)
  }
  return [...firstOfEach.values()].reduce<string | null>((latest, ts) => latest === null || ts > latest ? ts : latest, null)
}

function asSqlValue(value: unknown): string | null {
  if (value === undefined || value === null)
    return null
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function transcriptBeatsOf(db: DatabaseSync, row: LeasedRow): TranscriptBeat[] {
  return heartbeatsOfLease(db, { taskKey: row.task_key, leaseGen: Number(row.lease_gen) })
    .map(beat => ({ ts: beat.ts, spent: typeof beat.data?.spent === 'number' ? beat.data.spent : null, subagents: asSqlValue(beat.data?.subagents) }))
}

const REVIEW_STALL_MARKS = [REVIEW_STALL_MARK, REVIEW_ENDED_MARK].map(mark => `:${mark}`)

function reviewStallsOnHead(db: DatabaseSync, lease: Lease): { this_run: number, earlier_runs: number } {
  const stalls = events(db, { types: [SESSION_STALLED], card: lease.cardId, valid: true })
    .filter(stall => stall.head === lease.head && REVIEW_STALL_MARKS.some(mark => stall.dedupe_key.endsWith(mark)))
  const thisRun = stalls.filter(stall => (stall.data?.lease_gen ?? null) === lease.leaseGen).length
  return { this_run: thisRun, earlier_runs: stalls.length - thisRun }
}

export const UNDRIVEN_AFTER_MS = STALLED_AFTER_MS

const UNDRIVEN_MARK = 'session-over'

interface SessionEnd {
  pr: number | null
  head: string | null
  detail: string
}

function insideTree(dir: string, tree: string): boolean {
  return dir === tree || dir.startsWith(`${tree}${path.sep}`)
}

export function treeLives(table: ProcessTable, tree: string): boolean | null {
  const cwds = table.clientCwds()
  if (cwds.kind === 'unreadable')
    return null
  if (cwds.cwds.some(cwd => insideTree(cwd, tree)))
    return true
  const snapshot = table.snapshot()
  if (!snapshot.readable)
    return null
  return snapshot.rows.some(row => row.command.split(/\s+/).some(word => insideTree(word, tree)))
}

export class UndrivenSessions {
  constructor(private readonly db: DatabaseSync, private readonly trees: ProcessTable, private readonly prefix: string = '', private readonly roundMs: number = UNDRIVEN_AFTER_MS) {}

  sweep(nowMs: number): string[] {
    return unendedStarts(this.db).flatMap((start) => {
      const end = this.endOf(start, nowMs)
      return end !== null && this.record(start, end, nowMs) ? [`${this.prefix}${CARD_SESSION_ENDED} #${start.card_id}: ${end.detail}`] : []
    })
  }

  private endOf(start: UnendedStart, nowMs: number): SessionEnd | null {
    const named = `the session started at event ${start.id}`
    const push = firstPushAfter(this.db, start)
    if (push !== null)
      return { pr: push.pr, head: push.head, detail: `${named} pushed ${push.head}${push.pr === null ? '' : ` to PR #${push.pr}`}, over its base ${start.base ?? 'not recorded'}, so the bus records its end` }
    const release = firstReleaseAfter(this.db, start)
    if (release !== null)
      return { pr: null, head: null, detail: `${named} was released at event ${release}, so the bus records its end` }
    return this.undriven(start, named, nowMs)
  }

  private undriven(start: UnendedStart, named: string, nowMs: number): SessionEnd | null {
    const minutes = Math.floor((nowMs - Date.parse(start.ts)) / 60_000)
    if (start.worktree === null || nowMs - Date.parse(start.ts) < this.roundMs || treeLives(this.trees, start.worktree) !== false)
      return null
    return { pr: null, head: null, detail: `${named} ran ${minutes} min, past its round time of ${Math.floor(this.roundMs / 60_000)} min, and no live process runs in its tree ${start.worktree}, so the bus records its end` }
  }

  private record(start: UnendedStart, end: SessionEnd, nowMs: number): boolean {
    return appendEvent(this.db, { ts: new Date(nowMs).toISOString(), type: CARD_SESSION_ENDED, actor: STALLED_ACTOR, cardId: start.card_id, pr: end.pr, head: end.head, dedupeKey: `${CARD_SESSION_ENDED}:${UNDRIVEN_MARK}:${start.id}`, payload: { session: start.session, stopped: false, detail: end.detail }, legacy: false })
  }
}

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
  leasedAt: string
  lease: Lease
  queue: SupervisedQueue
  session: string | null
  since: string
  signals: Readonly<Record<Signal, Moved>>
}

export interface OverTime {
  check: (rounds: readonly LeasedRound[]) => string[]
}

export interface StalledSessionPorts {
  cards: CardTransitions
  lifeOf: LifeOf
  overTime?: OverTime
  stop?: StopSession
  save?: SaveTree
  spendOf?: SpendOf
  lines?: Readonly<Record<SupervisedQueue, number>>
  prefix?: string
  pulseOf?: PulseOf
  trees: ProcessTable
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

function treeOfCard(db: DatabaseSync, cardId: number): string | null {
  const started = events(db, { types: [CARD_STARTED], card: cardId, valid: true, newestFirst: true }).find(start => typeof start.data?.worktree === 'string')
  return (started?.data?.worktree ?? null) as string | null
}

export function overspendCommitMessage(lease: Lease, session: string): string {
  return `saved at the Eddies spend limit: #${lease.cardId} ${lease.queue} session ${session}\n\nCommitted by the bus supervisor from the card's worktree before it stopped the session; the next round starts a fresh session from this tree.`
}

export function saveCardTreeIn(db: DatabaseSync, git: GitRunner = processGit): SaveTree {
  return (lease, session) => {
    const tree = treeOfCard(db, lease.cardId)
    if (tree === null)
      return 'no card tree is recorded, so nothing was saved'
    try {
      if (git.succeeds(tree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']))
        return `${tree} is mid-merge, so its changes were left uncommitted in the tree`
      if (git.read(tree, ['status', '--porcelain']).trim() === '')
        return `${tree} held no uncommitted change`
      git.read(tree, ['add', '-A'])
      git.read(tree, ['commit', '-q', '--no-verify', '-m', overspendCommitMessage(lease, session)])
      return `its uncommitted change in ${tree} was committed on its branch`
    }
    catch (error) {
      return `saving ${tree} failed (${messageOf(error)}), its changes stay uncommitted in the tree`
    }
  }
}

export function spendInCardTree(db: DatabaseSync): SpendOf {
  return (lease, session) => {
    const tree = treeOfCard(db, lease.cardId)
    return tree === null ? null : spendStopOf(tree, session)
  }
}

export function actionInCardTree(db: DatabaseSync, clock: () => Date, actionIn = transcriptActionIn()): ActionOf {
  return (cardId, session) => {
    const tree = treeOfCard(db, cardId)
    return tree === null || session === null ? null : actionIn(tree, session, clock())
  }
}

export class StalledSessions {
  private lastSweep = Number.NEGATIVE_INFINITY
  private readonly lines: Readonly<Record<SupervisedQueue, number>>
  private readonly spendOf: SpendOf
  private readonly stop: StopSession
  private readonly save: SaveTree
  private readonly prefix: string
  private readonly pulseOf: PulseOf
  private readonly pulses = new Map<string, { pulse: string, at: string }>()
  private readonly overTime: OverTime
  private readonly undriven: UndrivenSessions

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly ports: StalledSessionPorts) {
    this.overTime = ports.overTime ?? new RoundOverTime(db, clock, actionInCardTree(db, clock))
    this.lines = ports.lines ?? NO_PROGRESS_LINES
    this.spendOf = ports.spendOf ?? spendInCardTree(db)
    this.stop = ports.stop ?? stopSessionIn(new OsProcessTable())
    this.save = ports.save ?? saveCardTreeIn(db)
    this.prefix = ports.prefix ?? ''
    this.pulseOf = ports.pulseOf ?? pulseIn(new OsProcessTable())
    this.undriven = new UndrivenSessions(db, ports.trees, this.prefix)
  }

  step(): string[] {
    const nowMs = this.clock().getTime()
    if (nowMs - this.lastSweep < STALLED_SWEEP_MS)
      return []
    this.lastSweep = nowMs
    return [...this.sweepSilent(nowMs), ...this.sweepUndriven(nowMs)]
  }

  private sweepSilent(nowMs: number): string[] {
    try {
      return this.sweep(nowMs)
    }
    catch (error) {
      return [`${this.prefix}reading the silent card sessions failed: ${messageOf(error)}; retried on the next sweep`]
    }
  }

  private sweepUndriven(nowMs: number): string[] {
    try {
      return this.undriven.sweep(nowMs)
    }
    catch (error) {
      return [`${this.prefix}reading the card sessions nobody drives failed: ${messageOf(error)}; retried on the next sweep`]
    }
  }

  private sweepOverTime(silences: readonly Silence[]): string[] {
    try {
      return this.overTime.check(silences.map(({ lease, session, leasedAt }) => ({ lease, session, leasedAt }))).map(line => `${this.prefix}${line}`)
    }
    catch (error) {
      return [`${this.prefix}reading the round times failed: ${messageOf(error)}; retried on the next sweep`]
    }
  }

  private sweep(nowMs: number): string[] {
    const rows = leasedSessions(this.db)
    const watched = new Set(rows.map(row => `${row.task_key}:${row.lease_gen}`))
    for (const key of this.pulses.keys()) {
      if (!watched.has(key))
        this.pulses.delete(key)
    }
    const silences = rows.flatMap((row) => {
      const silence = this.silenceOf(row, nowMs)
      return silence === null ? [] : [silence]
    })
    return [...silences.flatMap(silence => this.judge(silence, nowMs)), ...this.sweepOverTime(silences)]
  }

  private judge(silence: Silence, nowMs: number): string[] {
    const overSpend = this.overSpend(silence, nowMs)
    if (overSpend !== null)
      return overSpend
    if (nowMs - Date.parse(silence.since) < this.lines[silence.queue])
      return []
    return this.settle(silence, nowMs)
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
    const leased = leasedAt(this.db, row)
    if (leased === null)
      return null
    const beats = beatsOfLease(this.db, { taskKey: row.task_key, leaseGen: Number(row.lease_gen) })
    const pushed = EXPECTED_TO_PUSH.includes(row.queue) ? pushedAfter(this.db, row.card_id, leased.id) : null
    const lease: Lease = { taskKey: row.task_key, queue: row.queue, cardId: Number(row.card_id), pr: row.pr, head: row.head, leaseGen: Number(row.lease_gen), actor: leased.actor as string }
    const session = [...beats].reverse().find(beat => beat.session !== null)?.session ?? null
    const transcriptBeats = transcriptBeatsOf(this.db, row)
    const signals: Record<Signal, Moved> = {
      context: { readable: session !== null, at: lastProgress(leased.ts, beats, pushed) },
      transcript: transcriptMoved(leased.ts, transcriptBeats),
      process: row.queue === 'review' ? this.pulseMoved(`${row.task_key}:${row.lease_gen}`, session, nowMs) : { readable: false, at: leased.ts },
    }
    const since = Object.values(signals).filter(signal => signal.readable).map(signal => signal.at).reduce((latest, at) => at > latest ? at : latest, signals.context.at)
    return { lease, queue: row.queue, session, since, signals, leasedAt: leased.ts }
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
    const saved = this.save(lease, session)
    this.stop(session)
    const reason = `the ${queue} session ${session} of card #${lease.cardId} spent ${spend.spent} against the Eddies limit ${spend.limit} and was stopped; ${saved}; the next round starts a fresh session from that tree`
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
      return this.raise(lease, nowMs, { session, life, since, reason: `the review session ${session} of card #${lease.cardId} is alive and only ${stale.join(', ') || 'no signal'} stood still for ${minutes} min; one stale signal stops nothing, the session runs on` }, since)
    const stalls = reviewStallsOnHead(this.db, lease)
    if (stalls.this_run > 0)
      return []
    const stood = `${stale.join(', ')} stood still for ${minutes} min`
    const reason = stalls.earlier_runs > 0
      ? `the review of card #${lease.cardId} on head ${lease.head ?? 'none'} stalled a second time (${stood} in session ${session}); ${REVIEW_STALLED_TWICE}: the window may review the diff by slices, file groups each under the review budget; ${REVIEW_RUNS_ON}`
      : `the review session ${session} of card #${lease.cardId} made no step and no output: ${stood}; ${REVIEW_RUNS_ON}`
    return this.alarm(lease, nowMs, { session, life, since, reason }, REVIEW_STALL_MARK)
  }

  private alarm(lease: Lease, nowMs: number, payload: StalledPayload, mark: string): string[] {
    const raised = this.raise(lease, nowMs, payload, mark)
    if (raised.length > 0)
      appendEvent(this.db, { ts: new Date(nowMs).toISOString(), type: BOARD_ALARM, actor: STALLED_ACTOR, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${BOARD_ALARM}:${SESSION_STALLED}:${lease.taskKey}:${lease.leaseGen}:${mark}`, payload: { task_key: lease.taskKey, lease_gen: lease.leaseGen, reason: SESSION_STALLED, detail: payload.reason }, legacy: false })
    return raised
  }

  private requeue({ lease, session, since }: Silence, nowMs: number): string[] {
    const ts = new Date(nowMs).toISOString()
    const detail = `the ${lease.queue} session ${session} of card #${lease.cardId} made no push and no new step for ${this.minutesSince(since, nowMs)} min and its process is gone`
    const ended: BusEvent = { ts, type: CARD_SESSION_ENDED, actor: STALLED_ACTOR, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_SESSION_ENDED}:stalled:${lease.taskKey}:${lease.leaseGen}`, payload: { session, stopped: true, detail }, legacy: false }
    releaseTask(this.db, this.ports.cards, ts, { ...lease, actor: STALLED_ACTOR }, SESSION_STALLED_RELEASE, [ended])
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
