import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ghosts/verdict.js'
import type { BusEvent } from './db.js'
import type { GitHub } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import type { Denial, VerdictWord } from './record-verdict.js'
import type { Review, Reviewer } from './reviewer.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ghStatusPublisher } from '../ghosts/verdict.js'
import { defaultBusPath, openBus } from './db.js'
import { ghApi } from './github.js'
import { cardIdOfDescription, isFullSha, prOf, taskKey } from './identifiers.js'
import { POLICY_DENIED } from './inbox.js'
import { completeTask, expireLeases, failTask, leaseNext, renewLease, StaleLease } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { freshDenial, recordVerdict } from './record-verdict.js'
import { shadowProblems } from './report.js'
import { claudeReviewer, PREFIX } from './reviewer.js'

export const REVIEW_RECORDED = 'review.recorded'
export const RENEW_MS = 10 * 60_000
export const SWITCH_FLAG = '--on'
export const DRY_RUN_FLAG = '--dry-run'
export const DRY_RUN_ACTOR = 'worker:review:dry-run'
const REVIEWS_DIR = path.join(os.homedir(), '.construct', 'bus', 'reviews')

export type Step
  = | { kind: 'idle' }
    | { kind: 'recorded', taskKey: string, verdict: VerdictWord }
    | { kind: 'denied', taskKey: string, denial: Denial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface WorkerParts {
  db: DatabaseSync
  gitHub: GitHub
  publish: StatusPublisher
  reviewer: Reviewer
  clock: () => Date
  session: string
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

  private async reviewed(lease: Lease): Promise<Review | Denial> {
    try {
      return await this.parts.reviewer(lease)
    }
    catch (error) {
      return { kind: 'technical', reason: 'review_failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  private settle(lease: Lease, review: Review | Denial): Step {
    const { db, gitHub, publish, clock } = this.parts
    if ('kind' in review)
      return this.denied(lease, review)
    const outcome = recordVerdict(db, gitHub, publish, { lease, verdict: review.verdict, reviewerSession: review.session }, () => clock().getTime())
    if (outcome.kind === 'denied')
      return this.denied(lease, outcome.denial)
    completeTask(db, this.ts(), lease, [this.recorded(lease, review)])
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: review.verdict }
  }

  private recorded(lease: Lease, review: Review): BusEvent {
    return {
      ts: this.ts(),
      type: REVIEW_RECORDED,
      actor: this.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${REVIEW_RECORDED}:${lease.taskKey}:${lease.leaseGen}`,
      payload: { head: lease.head, verdict: review.verdict, reviewer_session: review.session, findings: review.findings },
      legacy: false,
    }
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

export function startReviewWorker(parts: WorkerParts): ReviewWorker {
  const problems = shadowProblems(parts.db, parts.gitHub, () => parts.clock().getTime())
  if (problems.length > 0)
    throw new ShadowNotClean(problems)
  return new ReviewWorker(parts)
}

export function stepLine(step: Step): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'recorded')
    return `${PREFIX}${step.taskKey}: ${step.verdict} recorded`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
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

export function dryRunLines(lease: Lease, review: Review): string[] {
  return [
    `${PREFIX}dry run of #${lease.pr} (card #${lease.cardId}) at ${lease.head}; nothing recorded`,
    `${PREFIX}verdict: ${review.verdict}`,
    `${PREFIX}reviewer session: ${review.session}`,
    ...(review.findings.length === 0 ? [`${PREFIX}findings: none`] : review.findings.map(finding => `${PREFIX}finding: ${finding}`)),
  ]
}

export async function dryRun(gitHub: GitHub, reviewer: Reviewer, pr: number): Promise<string[]> {
  const lease = dryRunLease(gitHub, pr)
  return dryRunLines(lease, await reviewer(lease))
}

export interface ReviewRun {
  busPath: string
  gitHub: GitHub
  publish: StatusPublisher
  reviewer: Reviewer
  session: string
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
    for (const line of await dryRun(run.gitHub, run.reviewer, mode.pr))
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
    clock: () => new Date(),
    session: run.session,
  }
  try {
    const worker = startReviewWorker(parts)
    console.log(`${PREFIX}${busPath}: the review worker ${worker.actor} takes the review queue`)
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
    session: randomUUID(),
    pause: sleep,
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
