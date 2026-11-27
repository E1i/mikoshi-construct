import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { EventPayload } from '../core/events.js'
import type { PreviousObservation, PreviousObservationOf, ReopeningOf } from '../core/observations.js'
import type { ReleaseRuns, RunJob } from './ci-reading.js'
import type { GitHub } from './github.js'
import type { ChangedPaths, ClosedPr, MainHead, OpenPr, Snapshot } from './snapshot.js'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { CHECK_MS, TICK_MS, WAKE_GAP_MS } from '../core/cadence.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { BUS_PULSE, declaredPayload, MAIN_ADVANCED, NETWATCH_SKIPPED, PR_CLOSED, PR_OBSERVED, RELEASE_RUN } from '../core/events.js'
import { closedKey, NETWATCH, pathsOfTheLastObservation, reopeningOf } from '../core/observations.js'
import { recordProcessHeartbeat } from '../supervisor/heartbeat.js'
import { GhCiRuns } from './ci-reading.js'
import { ghApi } from './github.js'
import { Meter, RateLimited } from './meter.js'
import { takeSnapshot } from './snapshot.js'

export const TECHNOLOGY_WORDS = ['database'] as const

export const PREFIX = '[bus:netwatch] '
export const NETWATCH_SCRIPT = 'bus:netwatch'

export type PollReason = 'start' | 'interval' | 'wake'

export type Poll
  = | { kind: 'ticked', reason: PollReason, calls: number, remaining: number | null, written: number, unsettled: number[] }
    | { kind: 'skipped', reason: PollReason, cause: 'retry-after' | 'rate-limited' | 'failed', calls: number, until?: string, detail?: string }

function observation(ts: string, type: string, fields: Pick<BusEvent, 'cardId' | 'pr' | 'head' | 'dedupeKey' | 'payload'>): BusEvent {
  return { ts, type, actor: NETWATCH, legacy: false, ...fields }
}

function digestOf(payloadText: string): string {
  return createHash('sha256').update(payloadText).digest('hex')
}

function pathsFields(changed: ChangedPaths | undefined): { paths?: string[], pathsTruncated?: boolean } {
  return changed === undefined ? {} : { paths: changed.paths, pathsTruncated: changed.pathsTruncated }
}

export function prObserved(ts: string, open: OpenPr, previous: PreviousObservation | null): BusEvent {
  const payload = {
    card_id: open.cardId,
    base: open.base,
    head: open.head,
    ...(open.branch === null ? {} : { branch: open.branch }),
    mergeable: open.mergeable,
    ...open.ciFields,
    ...((open.cancelledChecks ?? []).length === 0 ? {} : { cancelled_checks: open.cancelledChecks }),
    ...(open.verdictOnHead === null ? {} : { verdict_on_head: open.verdictOnHead }),
    auto_merge: open.autoMerge,
    draft: open.draft,
    body_sha: open.bodySha,
    ...pathsFields(open.changed),
  }
  const digest = digestOf(JSON.stringify(payload))
  const repeatsPrevious = previous !== null && digestOf(previous.payload) === digest
  const dedupeKey = repeatsPrevious ? previous.dedupeKey : `pr:${open.pr}:${digest}:${previous?.id ?? '-'}`
  return observation(ts, 'pr.observed', { cardId: open.cardId, pr: open.pr, head: open.head, dedupeKey, payload })
}

export function prClosed(ts: string, closed: ClosedPr, reopening: number | null = null): BusEvent {
  const payload = {
    merged: closed.merged,
    ...(closed.branch == null ? {} : { branch: closed.branch }),
    ...(closed.commit === null ? {} : { commit: closed.commit }),
    ...(closed.mergedBy === null ? {} : { merged_by: closed.mergedBy }),
    ...(closed.mergedAt === null ? {} : { merged_at: closed.mergedAt }),
  }
  return observation(ts, PR_CLOSED, { cardId: closed.cardId, pr: closed.pr, head: null, dedupeKey: closedKey(closed.pr, reopening), payload })
}

export function mainAdvanced(ts: string, main: MainHead): BusEvent {
  return observation(ts, 'main.advanced', { cardId: null, pr: null, head: null, dedupeKey: `main:${main.sha}`, payload: { sha: main.sha, touches_mechanics: main.touchesMechanics, ...pathsFields(main.changed) } })
}

export function observationsOf(ts: string, snapshot: Snapshot, previousOf: PreviousObservationOf, reopening: ReopeningOf = () => null): BusEvent[] {
  return [
    ...snapshot.open.map(open => prObserved(ts, open, previousOf(open.pr))),
    ...snapshot.closed.map(closed => prClosed(ts, closed, reopening(closed.pr))),
    ...(snapshot.main === null ? [] : [mainAdvanced(ts, snapshot.main)]),
  ]
}

function mainBeforeMovedHeads(events: readonly BusEvent[], headBefore: (pr: number) => string | null | undefined): BusEvent[] {
  const moved = (event: BusEvent): boolean => event.type === PR_OBSERVED && event.pr !== null && ![undefined, null, event.head].includes(headBefore(event.pr))
  const rest = events.filter(event => event.type !== MAIN_ADVANCED)
  const at = rest.findIndex(moved)
  const main = events.filter(event => event.type === MAIN_ADVANCED)
  return at === -1 ? [...rest, ...main] : [...rest.slice(0, at), ...main, ...rest.slice(at)]
}

function mainPayloadWithCi(observed: EventPayload<typeof MAIN_ADVANCED>, ci: string): EventPayload<typeof MAIN_ADVANCED> {
  return declaredPayload(MAIN_ADVANCED, { ...observed, ci })
}

function withMainCi(event: BusEvent, ci: string | undefined): BusEvent {
  if (event.type !== MAIN_ADVANCED || ci === undefined)
    return event
  return { ...event, payload: mainPayloadWithCi(event.payload as EventPayload<typeof MAIN_ADVANCED>, ci) }
}

const COMPLETED_RUN = 'completed'
const GREEN_CONCLUSIONS: readonly (string | null)[] = ['success', 'skipped', 'neutral']
const FAILED_CONCLUSIONS: readonly (string | null | undefined)[] = ['failure', 'timed_out', 'cancelled', 'startup_failure']

function failedStepOf(jobs: readonly RunJob[]): string | null {
  const job = jobs.find(each => FAILED_CONCLUSIONS.includes(each.conclusion))
  if (job === undefined)
    return null
  const step = (job.steps ?? []).find(each => FAILED_CONCLUSIONS.includes(each.conclusion))
  return step === undefined ? job.name : `${job.name} › ${step.name}`
}

export function releaseRun(ts: string, sha: string, releases: ReleaseRuns): BusEvent | null {
  const run = releases.releaseRunOn(sha)
  if (run.kind === 'failed' || run.value === null || run.value.status !== COMPLETED_RUN)
    return null
  const { databaseId, conclusion } = run.value
  const jobs = releases.jobsOfRun(databaseId)
  if (jobs.kind === 'failed')
    return null
  const steps = jobs.value.jobs.flatMap(job => (job.steps ?? []).map(step => ({ job: job.name, step: step.name, conclusion: step.conclusion ?? null })))
  const green = GREEN_CONCLUSIONS.includes(conclusion)
  const payload = declaredPayload(RELEASE_RUN, { sha, run_id: databaseId, conclusion, verdict: green ? 'green' : 'red', failed_step: green ? null : failedStepOf(jobs.value.jobs), steps })
  return observation(ts, RELEASE_RUN, { cardId: null, pr: null, head: null, dedupeKey: `${RELEASE_RUN}:${databaseId}:${conclusion}`, payload })
}

function record<T extends typeof BUS_PULSE | typeof NETWATCH_SKIPPED>(ts: string, type: T, payload: EventPayload<T>): BusEvent {
  return { ts, type, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: `${type}:${ts}`, payload, legacy: false }
}

export interface PrHistory {
  knownOpenPrs: (db: DatabaseSync) => number[]
  lastMainSha: (db: DatabaseSync) => string | null
  lastObservation: (db: DatabaseSync, pr: number) => PreviousObservation | null
  unreleasedMainShas?: (db: DatabaseSync) => string[]
}

export class NetWatch {
  private lastPollAt: number | null = null
  private blockedUntil = 0

  constructor(private readonly db: DatabaseSync, private readonly gitHub: GitHub, private readonly clock: () => Date, private readonly process: string, private readonly requiredCheck: () => string, private readonly history: PrHistory, private readonly releases: ReleaseRuns | null = null) {}

  private lastObservation(pr: number): PreviousObservation | null {
    return this.history.lastObservation(this.db, pr)
  }

  private releaseRuns(ts: string, observedMain: string | undefined): BusEvent[] {
    const releases = this.releases
    if (releases === null)
      return []
    const shas = new Set([...(observedMain === undefined ? [] : [observedMain]), ...(this.history.unreleasedMainShas?.(this.db) ?? [])])
    return [...shas].flatMap(sha => releaseRun(ts, sha, releases) ?? [])
  }

  dueReason(nowMs: number): PollReason | null {
    if (this.lastPollAt === null)
      return 'start'
    const gap = nowMs - this.lastPollAt
    if (gap > WAKE_GAP_MS)
      return 'wake'
    return gap >= TICK_MS ? 'interval' : null
  }

  poll(): Poll | null {
    const now = this.clock()
    const nowMs = now.getTime()
    const reason = this.dueReason(nowMs)
    if (reason === null)
      return null
    const gapSeconds = this.lastPollAt === null ? null : Math.round((nowMs - this.lastPollAt) / 1000)
    this.lastPollAt = nowMs
    const ts = now.toISOString()
    recordProcessHeartbeat(this.db, ts, this.process)
    if (nowMs < this.blockedUntil)
      return this.skipped(ts, { kind: 'skipped', reason, cause: 'retry-after', calls: 0, until: new Date(this.blockedUntil).toISOString() })
    const meter = new Meter(this.gitHub, () => this.clock().getTime())
    try {
      const snapshot = takeSnapshot(meter, this.history.knownOpenPrs(this.db), this.history.lastMainSha(this.db), this.requiredCheck(), (pr, head) => pathsOfTheLastObservation(this.lastObservation(pr), head))
      const poll: Poll = { kind: 'ticked', reason, calls: meter.calls, remaining: meter.remaining, written: 0, unsettled: snapshot.unsettled }
      const released = this.releaseRuns(ts, snapshot.main?.sha)
      inTransaction(this.db, () => {
        const observed = observationsOf(ts, snapshot, pr => this.lastObservation(pr), reopeningOf(this.db))
        for (const event of [...mainBeforeMovedHeads(observed, pr => this.lastObservation(pr)?.event?.head).map(each => withMainCi(each, snapshot.main?.ci)), ...released]) {
          if (appendEvent(this.db, event))
            poll.written += 1
        }
        appendEvent(this.db, record(ts, BUS_PULSE, { reason, gap_s: gapSeconds, calls: poll.calls, rate_remaining: poll.remaining, written: poll.written, unsettled: poll.unsettled }))
      })
      return poll
    }
    catch (error) {
      if (error instanceof RateLimited) {
        this.blockedUntil = nowMs + error.retryAfterSeconds * 1000
        return this.skipped(ts, { kind: 'skipped', reason, cause: 'rate-limited', calls: meter.calls, until: new Date(this.blockedUntil).toISOString(), detail: error.message })
      }
      return this.skipped(ts, { kind: 'skipped', reason, cause: 'failed', calls: meter.calls, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  private skipped(ts: string, poll: Extract<Poll, { kind: 'skipped' }>): Poll {
    appendEvent(this.db, record(ts, NETWATCH_SKIPPED, { reason: poll.reason, cause: poll.cause, calls: poll.calls, until: poll.until ?? null, detail: poll.detail ?? null }))
    return poll
  }
}

export function pollLine(poll: Poll): string {
  if (poll.kind === 'ticked')
    return `${PREFIX}tick (${poll.reason}): ${poll.calls} calls, ${poll.remaining ?? '?'} remaining, ${poll.written} new events${poll.unsettled.length === 0 ? '' : `, mergeable not settled on #${poll.unsettled.join(', #')}`}`
  return `${PREFIX}skipped (${poll.reason}, ${poll.cause}): ${poll.calls} calls${poll.until === undefined ? '' : `, until ${poll.until}`}${poll.detail === undefined ? '' : `: ${poll.detail}`}`
}

export async function watchTheNetwork(requiredCheck: () => string, once: boolean, history: PrHistory): Promise<number> {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const netWatch = new NetWatch(db, ghApi(process.cwd()), () => new Date(), NETWATCH_SCRIPT, requiredCheck, history, new GhCiRuns())
  console.log(`${PREFIX}${busPath}, a tick every ${TICK_MS / 1000} s${once ? ', once' : ''}`)
  try {
    for (;;) {
      const poll = netWatch.poll()
      if (poll !== null)
        console.log(pollLine(poll))
      if (once)
        return poll?.kind === 'ticked' ? 0 : 1
      await sleep(CHECK_MS)
    }
  }
  finally {
    db.close()
  }
}
