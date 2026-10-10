import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ghosts/verdict.js'
import type { BusEvent } from './db.js'
import type { GitHub } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import type { Denial, VerdictWord } from './record-verdict.js'
import type { EarlierVerdict, ReviewDepth, ReviewPlan, ReviewPlanner } from './review-depth.js'
import type { Review, Reviewer } from './reviewer.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultParking } from '../ghosts/handoff-check.js'
import { ghStatusPublisher } from '../ghosts/verdict.js'
import { defaultBusPath, openBus } from './db.js'
import { gitReviewPlanner } from './depth-sources.js'
import { ghApi } from './github.js'
import { cardIdOfDescription, isFullSha, prOf, taskKey } from './identifiers.js'
import { POLICY_DENIED } from './inbox.js'
import { completeTask, expireLeases, failTask, leaseNext, releaseTask, RENEW_MS, renewLease, StaleLease } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { freshDenial, recordVerdict } from './record-verdict.js'
import { shadowProblems } from './report.js'
import { fullReview } from './review-depth.js'
import { claudeReviewer, PREFIX } from './reviewer.js'
import { slotsOf } from './scheduler.js'

export const REVIEW_RECORDED = 'review.recorded'
export const SWITCH_FLAG = '--on'
export const DRY_RUN_FLAG = '--dry-run'
export const DRY_RUN_ACTOR = 'worker:review:dry-run'
const CI_NOT_READY = 'ci_not_ready'
const REVIEWS_DIR = path.join(os.homedir(), '.construct', 'bus', 'reviews')
const MORSE_JOURNAL = path.join(os.homedir(), '.construct', 'bus', 'morse.jsonl')

export type Step
  = | { kind: 'idle' }
    | { kind: 'recorded', taskKey: string, verdict: VerdictWord, depth: ReviewDepth }
    | { kind: 'denied', taskKey: string, denial: Denial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }
    | { kind: 'waiting', taskKey: string, detail: string }

export interface WorkerParts {
  db: DatabaseSync
  gitHub: GitHub
  publish: StatusPublisher
  reviewer: Reviewer
  plan: ReviewPlanner
  clock: () => Date
  session: string
}

interface Reviewed {
  review: Review
  plan: ReviewPlan
  ms: number
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []
}

export function earlierVerdict(db: DatabaseSync, lease: Lease): EarlierVerdict | null {
  if (lease.pr === null || lease.head === null)
    return null
  const row = db.prepare('SELECT payload FROM events WHERE type = ? AND pr = ? AND head != ? AND legacy = 0 ORDER BY id DESC LIMIT 1').get(REVIEW_RECORDED, lease.pr, lease.head) as { payload: string } | undefined
  if (row === undefined)
    return null
  const payload = JSON.parse(row.payload) as { head?: unknown, verdict?: unknown, findings?: unknown }
  return typeof payload.head === 'string' && typeof payload.verdict === 'string'
    ? { head: payload.head, verdict: payload.verdict, findings: strings(payload.findings) }
    : null
}

export function planned(planner: ReviewPlanner, lease: Lease, earlier: EarlierVerdict | null): ReviewPlan {
  try {
    return planner(lease, earlier)
  }
  catch (error) {
    return fullReview(`the depth could not be planned: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export class ShadowNotClean extends Error {
  constructor(readonly problems: string[]) {
    super(`the shadow report is not clean: ${problems.join('; ')}`)
  }
}

export class ReviewWorker {
  readonly actor: string

  constructor(private readonly parts: WorkerParts) {
    this.actor = `worker:review:${parts.session}`
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  async step(): Promise<Step> {
    const { db } = this.parts
    expireLeases(db, this.ts())
    const lease = leaseNext(db, this.ts(), 'review', this.actor)
    if (lease === null)
      return { kind: 'idle' }
    const stale = freshDenial(this.parts.gitHub, lease, () => this.parts.clock().getTime())
    if (stale?.kind === 'technical' && stale.reason === CI_NOT_READY)
      return this.waiting(lease, stale.detail)
    if (stale !== null)
      return this.denied(lease, stale)
    const heartbeat = setInterval(() => {
      try {
        renewLease(db, this.ts(), lease)
      }
      catch (error) {
        if (error instanceof StaleLease)
          clearInterval(heartbeat)
        else
          console.error(`${PREFIX}${lease.taskKey}: the lease was not renewed this beat, the heartbeat keeps running: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, RENEW_MS)
    try {
      return this.settle(lease, await this.reviewed(lease))
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
    finally {
      clearInterval(heartbeat)
    }
  }

  private async reviewed(lease: Lease): Promise<Reviewed | Denial> {
    const { db, clock } = this.parts
    const plan = planned(this.parts.plan, lease, earlierVerdict(db, lease))
    try {
      const started = clock().getTime()
      const review = await this.parts.reviewer(lease, plan)
      return { review, plan, ms: clock().getTime() - started }
    }
    catch (error) {
      return { kind: 'technical', reason: 'review_failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  private settle(lease: Lease, reviewed: Reviewed | Denial): Step {
    const { db, gitHub, publish, clock } = this.parts
    if ('kind' in reviewed)
      return this.denied(lease, reviewed)
    const { review, plan } = reviewed
    const outcome = recordVerdict(db, gitHub, publish, { lease, verdict: review.verdict, reviewerSession: review.session }, () => clock().getTime())
    if (outcome.kind === 'denied')
      return this.denied(lease, outcome.denial)
    completeTask(db, this.ts(), lease, [this.recorded(lease, reviewed)])
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: review.verdict, depth: plan.depth }
  }

  private recorded(lease: Lease, { review, plan, ms }: Reviewed): BusEvent {
    return {
      ts: this.ts(),
      type: REVIEW_RECORDED,
      actor: this.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${REVIEW_RECORDED}:${lease.taskKey}:${lease.leaseGen}`,
      payload: { head: lease.head, verdict: review.verdict, depth: plan.depth, depth_why: plan.why, review_ms: ms, reviewer_session: review.session, findings: review.findings },
      legacy: false,
    }
  }

  private waiting(lease: Lease, detail: string): Step {
    releaseTask(this.parts.db, this.ts(), lease, CI_NOT_READY)
    return { kind: 'waiting', taskKey: lease.taskKey, detail }
  }

  private denied(lease: Lease, denial: Denial): Step {
    const ts = this.ts()
    const reason = denial.kind === 'technical' ? denial.reason : denial.rule
    const event: BusEvent = {
      ts,
      type: POLICY_DENIED,
      actor: 'policy',
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`,
      payload: { command: 'record_verdict', ...denial },
      legacy: false,
    }
    const next = failTask(this.parts.db, ts, lease, { reason, withdraw: denial.kind === 'authority' }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

export function startReviewWorkers(parts: WorkerParts, slots: number): ReviewWorker[] {
  const problems = shadowProblems(parts.db, parts.gitHub, () => parts.clock().getTime())
  if (problems.length > 0)
    throw new ShadowNotClean(problems)
  return Array.from({ length: slots }, (_, slot) => new ReviewWorker({ ...parts, session: `${parts.session}-${slot + 1}` }))
}

async function keepReviewing(worker: ReviewWorker, pause: (ms: number) => Promise<unknown>): Promise<never> {
  for (;;) {
    const step = await worker.step()
    const line = stepLine(step)
    if (line !== null)
      console.log(line)
    if (step.kind === 'idle')
      await pause(CHECK_MS)
    else if (step.kind !== 'recorded')
      await pause(TICK_MS)
  }
}

export function stepLine(step: Step): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'recorded')
    return `${PREFIX}${step.taskKey}: ${step.verdict} recorded, review depth ${step.depth}`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  if (step.kind === 'waiting')
    return `${PREFIX}${step.taskKey}: not reviewed yet, ${step.detail}; the task is queued again with no failure counted`
  const reason = step.denial.kind === 'technical' ? step.denial.reason : step.denial.rule
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${reason}): ${step.denial.detail}; the task is ${step.next}`
}

export type ReviewMode
  = | { kind: 'off' }
    | { kind: 'on' }
    | { kind: 'dry-run', pr: number }
    | { kind: 'refused', reason: string }

const DECIMAL = /^\d+$/

export function reviewMode(argv: string[]): ReviewMode {
  const on = argv.includes(SWITCH_FLAG)
  const dry = argv.indexOf(DRY_RUN_FLAG)
  if (dry === -1)
    return on ? { kind: 'on' } : { kind: 'off' }
  if (on)
    return { kind: 'refused', reason: `${DRY_RUN_FLAG} records nothing and ${SWITCH_FLAG} records verdicts; give one of them, not both` }
  const given = argv[dry + 1] ?? ''
  const pr = DECIMAL.test(given) ? prOf(Number(given)) : null
  return pr === null ? { kind: 'refused', reason: `${DRY_RUN_FLAG} needs a pull request number: ${DRY_RUN_FLAG} <pr>` } : { kind: 'dry-run', pr }
}

export function dryRunLease(gitHub: GitHub, pr: number): Lease {
  const response = gitHub(`repos/{owner}/{repo}/pulls/${pr}`)
  if (response.status !== 200)
    throw new Error(`GitHub answered ${response.status} for pull request #${pr}`)
  const pull = response.body as { head?: { sha?: unknown }, body?: string | null }
  const head = pull.head?.sha
  if (!isFullSha(head))
    throw new Error(`pull request #${pr} has no head sha on GitHub`)
  const cardId = cardIdOfDescription(pull.body)
  if (cardId === null)
    throw new Error(`the first line of pull request #${pr} names no card`)
  return { taskKey: taskKey({ queue: 'review', cardId, pr, head }), queue: 'review', cardId, pr, head, leaseGen: 0, actor: DRY_RUN_ACTOR }
}

export function dryRunLines(lease: Lease, plan: ReviewPlan, review: Review): string[] {
  return [
    `${PREFIX}dry run of #${lease.pr} (card #${lease.cardId}) at ${lease.head}; nothing recorded`,
    `${PREFIX}review depth: ${plan.depth}, ${plan.why}`,
    `${PREFIX}verdict: ${review.verdict}`,
    `${PREFIX}reviewer session: ${review.session}`,
    ...(review.findings.length === 0 ? [`${PREFIX}findings: none`] : review.findings.map(finding => `${PREFIX}finding: ${finding}`)),
  ]
}

export async function dryRun(gitHub: GitHub, reviewer: Reviewer, planner: ReviewPlanner, pr: number): Promise<string[]> {
  const lease = dryRunLease(gitHub, pr)
  const plan = planned(planner, lease, null)
  return dryRunLines(lease, plan, await reviewer(lease, plan))
}

export interface ReviewRun {
  busPath: string
  gitHub: GitHub
  publish: StatusPublisher
  reviewer: Reviewer
  plan: ReviewPlanner
  session: string
  slots: number
  pause: (ms: number) => Promise<unknown>
}

export async function runReview(argv: string[], run: ReviewRun): Promise<number> {
  const mode = reviewMode(argv)
  if (mode.kind === 'refused') {
    console.error(`${PREFIX}${mode.reason}`)
    return 1
  }
  if (mode.kind === 'off') {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG} once pnpm bus:report is clean`)
    return 0
  }
  if (mode.kind === 'dry-run') {
    for (const line of await dryRun(run.gitHub, run.reviewer, run.plan, mode.pr))
      console.log(line)
    return 0
  }
  const { busPath, pause } = run
  const db = openBus(busPath)
  const parts: WorkerParts = {
    db,
    gitHub: run.gitHub,
    publish: run.publish,
    reviewer: run.reviewer,
    plan: run.plan,
    clock: () => new Date(),
    session: run.session,
  }
  try {
    const workers = startReviewWorkers(parts, run.slots)
    for (const worker of workers)
      console.log(`${PREFIX}${busPath}: the review worker ${worker.actor} takes the review queue`)
    return await Promise.race(workers.map(worker => keepReviewing(worker, pause)))
  }
  catch (error) {
    if (!(error instanceof ShadowNotClean))
      throw error
    console.error(`${PREFIX}refused to start, the shadow report is not clean:\n${error.problems.map(problem => `  ${problem}`).join('\n')}`)
    return 1
  }
  finally {
    db.close()
  }
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  return runReview(process.argv.slice(2), {
    busPath: defaultBusPath(),
    gitHub: ghApi(cwd),
    publish: ghStatusPublisher(cwd),
    reviewer: claudeReviewer(cwd, REVIEWS_DIR),
    plan: gitReviewPlanner(cwd, MORSE_JOURNAL, defaultParking(os.homedir())),
    session: randomUUID(),
    slots: slotsOf('review', process.env),
    pause: sleep,
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
