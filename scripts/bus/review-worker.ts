import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ghosts/verdict.js'
import type { BusEvent } from './db.js'
import type { GitHub } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import type { Denial, VerdictWord } from './record-verdict.js'
import type { EarlierVerdict, ReviewDepth, ReviewPlan, ReviewPlanner } from './review-depth.js'
import type { LeftoverTree, Review, Reviewer } from './reviewer.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultParking } from '../ghosts/handoff-check.js'
import { ghStatusPublisher } from '../ghosts/verdict.js'
import { REVIEW_RECORDED } from './card-automaton.js'
import { ARTIFACT_REMOVED } from './close-executor.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { gitReviewPlanner } from './depth-sources.js'
import { ghApi } from './github.js'
import { cardIdOfDescription, isFullSha, prBodySha, prOf, reviewInputOf, taskKey } from './identifiers.js'
import { POLICY_DENIED } from './inbox.js'
import { completeTask, expireLeases, failTask, leaseNext, leaseQueued, releaseTask, RENEW_MS, renewLease, StaleLease } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { BOARD_ALARM, cardBodyShaOfCard, changesRoundsOf, REVIEW_ROUNDS } from './queue.js'
import { freshDenial, recordVerdict } from './record-verdict.js'
import { shadowProblems } from './report.js'
import { fullReview } from './review-depth.js'
import { claudeReviewer, PREFIX, ReviewTrees } from './reviewer.js'
import { slotsOf } from './scheduler.js'
import { openDatabase } from './sqlite.js'

export const SWITCH_FLAG = '--on'
export const DRY_RUN_FLAG = '--dry-run'
export const DRY_RUN_ACTOR = 'worker:review:dry-run'
const CI_NOT_READY = 'ci_not_ready'
export const TREE_LEFT = 'tree_left'
export const REVIEW_ROUNDS_SPENT = 'review.rounds_spent'
export const ROUND_LIMIT_REACHED = 'round_limit_reached'
const BUS_DIR = path.join(os.homedir(), '.construct', 'bus')
const MORSE_JOURNAL = path.join(os.homedir(), '.construct', 'bus', 'morse.jsonl')

export type Step
  = | { kind: 'idle' }
    | { kind: 'recorded', taskKey: string, verdict: VerdictWord, depth: ReviewDepth, model?: string }
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
  clearLeftovers?: () => LeftoverTree[]
  notePr?: (pr: number, line: string) => void
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
    expireLeases(this.parts.db, this.ts())
    const lease = leaseNext(this.parts.db, this.ts(), 'review', this.actor)
    return lease === null ? { kind: 'idle' } : this.review(lease)
  }

  async stepOn(key: string): Promise<Step> {
    expireLeases(this.parts.db, this.ts())
    const lease = leaseQueued(this.parts.db, this.ts(), key, this.actor)
    return lease === null ? { kind: 'idle' } : this.review(lease)
  }

  private async review(lease: Lease): Promise<Step> {
    if (this.parts.clearLeftovers !== undefined)
      recordLeftovers(this.parts.db, this.actor, this.ts(), this.parts.clearLeftovers())
    const stale = freshDenial(this.parts.gitHub, lease, () => this.parts.clock().getTime())
    if (stale?.kind === 'technical' && stale.reason === CI_NOT_READY)
      return this.waiting(lease, stale.detail)
    if (stale !== null)
      return this.denied(lease, stale)
    const heartbeat = setInterval(() => {
      try {
        renewLease(this.parts.db, this.ts(), lease)
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
    const spent = this.roundsSpent(lease, review)
    completeTask(db, this.ts(), lease, [this.recorded(lease, reviewed), ...(spent === null ? [] : [spent])])
    if (spent !== null && lease.pr !== null)
      this.noted(lease.pr, roundLimitLine(lease.pr, REVIEW_ROUNDS))
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: review.verdict, depth: plan.depth, model: review.model }
  }

  private roundsSpent(lease: Lease, review: Review): BusEvent | null {
    if (review.verdict !== 'changes' || lease.pr === null)
      return null
    const rounds = changesRoundsOf(this.parts.db, lease.pr) + 1
    if (rounds < REVIEW_ROUNDS)
      return null
    return {
      ts: this.ts(),
      type: REVIEW_ROUNDS_SPENT,
      actor: this.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${REVIEW_ROUNDS_SPENT}:${lease.pr}`,
      payload: { state: ROUND_LIMIT_REACHED, pr: lease.pr, rounds, findings: review.findings },
      legacy: false,
    }
  }

  private noted(pr: number, line: string): void {
    try {
      this.parts.notePr?.(pr, line)
    }
    catch (error) {
      console.error(`${PREFIX}PR #${pr}: the round-limit line was not added to its body, the bus event holds the report: ${error instanceof Error ? error.message : String(error)}`)
    }
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
      payload: { head: lease.head, verdict: review.verdict, depth: plan.depth, depth_why: plan.why, review_ms: ms, reviewer_session: review.session, model: review.model, findings: review.findings },
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

export function roundLimitLine(pr: number, rounds: number): string {
  return `Review round limit reached (D-104): ${rounds} rounds of changes on PR #${pr}; the bus queues no further review or answer for it and does not merge it. The remaining findings are in the bus event ${REVIEW_ROUNDS_SPENT}.`
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
    return `${PREFIX}${step.taskKey}: ${step.verdict} recorded, review depth ${step.depth}, model ${step.model ?? 'not reported by the session'}`
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

export function reviewsDir(busDir: string, mode: ReviewMode): string {
  return path.join(busDir, mode.kind === 'dry-run' ? 'dry-run-reviews' : 'reviews')
}

export type CardBodyOf = (cardId: number) => string | null

const NO_CARD_BODY: CardBodyOf = () => null

export function busCardBody(busPath: string): CardBodyOf {
  return (cardId) => {
    if (!existsSync(busPath))
      return null
    const db = openDatabase(busPath, { readOnly: true })
    try {
      return cardBodyShaOfCard(db, cardId)
    }
    finally {
      db.close()
    }
  }
}

export function dryRunLease(gitHub: GitHub, pr: number, cardBodyOf: CardBodyOf = NO_CARD_BODY): Lease {
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
  return { taskKey: taskKey({ queue: 'review', cardId, pr, head, input: reviewInputOf(prBodySha(pull.body), cardBodyOf(cardId)) }), queue: 'review', cardId, pr, head, leaseGen: 0, actor: DRY_RUN_ACTOR }
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

export async function dryRun(gitHub: GitHub, reviewer: Reviewer, planner: ReviewPlanner, pr: number, cardBodyOf: CardBodyOf = NO_CARD_BODY): Promise<string[]> {
  const lease = dryRunLease(gitHub, pr, cardBodyOf)
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
  clearLeftovers: () => LeftoverTree[]
  notePr?: (pr: number, line: string) => void
}

export function ghNotePr(cwd: string): (pr: number, line: string) => void {
  return (pr, line) => {
    const view = execFileSync('gh', ['pr', 'view', String(pr), '--json', 'body', '-q', '.body'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('gh', ['pr', 'edit', String(pr), '--body-file', '-'], { cwd, input: `${view.trimEnd()}\n\n${line}\n`, stdio: ['pipe', 'pipe', 'pipe'] })
  }
}

export function recordLeftovers(db: DatabaseSync, actor: string, ts: string, leftovers: LeftoverTree[]): void {
  for (const tree of leftovers) {
    const event: BusEvent = tree.left === null
      ? { ts, type: ARTIFACT_REMOVED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ARTIFACT_REMOVED}:review:${tree.path}`, payload: { path: tree.path, by: actor }, legacy: false }
      : { ts, type: BOARD_ALARM, actor, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${TREE_LEFT}:${tree.path}:${actor}`, payload: { reason: TREE_LEFT, path: tree.path, detail: tree.left }, legacy: false }
    appendEvent(db, event)
  }
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
    for (const line of await dryRun(run.gitHub, run.reviewer, run.plan, mode.pr, busCardBody(run.busPath)))
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
    clearLeftovers: run.clearLeftovers,
    notePr: run.notePr,
  }
  try {
    const workers = startReviewWorkers(parts, run.slots)
    recordLeftovers(db, `worker:review:${run.session}`, parts.clock().toISOString(), run.clearLeftovers())
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
  const argv = process.argv.slice(2)
  const trees = new ReviewTrees(cwd, reviewsDir(BUS_DIR, reviewMode(argv)))
  return runReview(argv, {
    busPath: defaultBusPath(),
    gitHub: ghApi(cwd),
    publish: ghStatusPublisher(cwd),
    reviewer: claudeReviewer(trees),
    plan: gitReviewPlanner(cwd, MORSE_JOURNAL, defaultParking(os.homedir())),
    session: randomUUID(),
    slots: slotsOf('review', process.env),
    pause: sleep,
    clearLeftovers: () => trees.clearLeftovers(),
    notePr: ghNotePr(cwd),
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
