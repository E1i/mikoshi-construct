import type { DatabaseSync } from 'node:sqlite'
import type { GhCallOptions, GhPort } from '../core/gh.js'
import type { StatusPublisher } from '../ports/github-status.js'
import type { IsolationReader } from '../ports/isolation.js'
import type { DryRunRecord } from './dry-run-record.js'
import type { GitHub } from './github.js'
import type { SessionMeasure } from './heartbeat.js'
import type { Lease } from './lease.js'
import type { DetectionMode, Scope } from './node.js'
import type { QueuedTask } from './queue.js'
import type { ReadSet } from './report.js'
import type { ReviewPlan, ReviewPlanner } from './review-depth.js'
import type { ExecutorParts, Step } from './review-executor.js'
import type { HeldTree, LeftoverTree, Review, Reviewer, SessionPulse, TreeTools } from './reviewer.js'
import type { StoredEvent } from './stored.js'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, PR_CLOSED, PR_OBSERVED, PR_OPENED, REDUCED, REVIEW_RECORDED, SESSION_HEARTBEAT, TASK_COMPLETED, TASK_ENQUEUED, TASK_EXPIRED, TASK_FAILED, TASK_RELEASED, TASK_REQUEUED, TASK_SUPERSEDED } from '../core/events.js'
import { GhFailed, PROCESS_GH_PORT } from '../core/gh.js'
import { defaultParking } from '../ghosts/handoff-check.js'
import { ghStatusPublisher } from '../ports/github-status.js'
import { realIsolationReader } from '../ports/isolation.js'
import { HEADLESS_FLAGS, spawnSession } from '../ports/session.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from './db.js'
import { gitReviewPlanner } from './depth-sources.js'
import { recordForeignDivergences } from './divergence-alarm.js'
import { keepDryRun } from './dry-run-record.js'
import { ghApi } from './github.js'
import { busSessionPulse, measureSession } from './heartbeat.js'
import { cardIdOfDescription, isFullSha, prBodySha, prOf, reviewInputOf, taskKey } from './identifiers.js'
import { expireLeases, leaseNext, leaseQueued } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { Node, runNode, SWITCH_FLAG } from './node.js'
import { promptsDirOf } from './prompt-store.js'
import { cardBodyShaOfCard, LEASED, reviewCandidates } from './queue.js'
import { shadowReading } from './report.js'
import { planned, recordLeftovers, ReviewExecutor } from './review-executor.js'
import { claudeReviewer, GIT_TREE_TOOLS, PREFIX, ReviewFailed, ReviewTrees } from './reviewer.js'
import { slotsOf, slotsVariable } from './scheduler.js'
import { openDatabase } from './sqlite.js'
import { stampLogOutput } from './stamp.js'

export { SWITCH_FLAG }
export { earlierVerdict, planned, recordLeftovers, REVIEW_ROUNDS_SPENT, ROUND_LIMIT_REACHED, roundLimitLine, SPAWNS_NO_SESSION, TREE_LEFT } from './review-executor.js'
export type { Step }

export const DRY_RUN_FLAG = '--dry-run'
export const DRY_RUN_ACTOR = 'worker:review:dry-run'
const BUS_DIR = path.join(os.homedir(), '.construct', 'bus')
const MORSE_JOURNAL = path.join(os.homedir(), '.construct', 'bus', 'morse.jsonl')

export const REVIEW_ON = [REDUCED, PR_OBSERVED, PR_CLOSED, PR_OPENED, REVIEW_RECORDED, CARD_ADMITTED, TASK_ENQUEUED, TASK_REQUEUED, TASK_SUPERSEDED, TASK_COMPLETED, TASK_FAILED, TASK_RELEASED, TASK_EXPIRED] as const

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED])
const SCOPED_BY_CARD_ON: ReadonlySet<string> = new Set([CARD_ADMITTED])

export const REVIEW_READS: ReadSet = new Set(['prs', 'tasks', 'cards', 'card_bodies', 'mains', 'chains'])

export interface WorkerParts extends ExecutorParts {
  session: string
}

export class ShadowNotClean extends Error {
  constructor(readonly problems: string[]) {
    super(`the shadow report is not clean: ${problems.join('; ')}`)
  }
}

function scopeOf(event: StoredEvent): Scope | undefined {
  if (WHOLE_QUEUE_ON.has(event.type))
    return undefined
  if (SCOPED_BY_CARD_ON.has(event.type))
    return { cardId: event.card_id ?? undefined }
  return { pr: event.pr ?? undefined }
}

function inScope(task: QueuedTask, scope: Scope): boolean {
  return (scope.pr === undefined || task.pr === scope.pr) && (scope.cardId === undefined || task.cardId === scope.cardId)
}

export interface ReviewNodeParts extends ExecutorParts {
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
}

export class ReviewNode extends Node<Step> {
  private readonly executor: ReviewExecutor

  constructor(private readonly reviewParts: ReviewNodeParts) {
    super('review', { db: reviewParts.db, clock: reviewParts.clock, session: reviewParts.session, mode: reviewParts.mode, env: reviewParts.env })
    this.executor = new ReviewExecutor(reviewParts)
    this.subscribe(REVIEW_ON, event => this.detectOn(event, scopeOf(event)))
  }

  protected override renewsByTimer(): boolean {
    return false
  }

  protected override before(): void {
    const { db, clearLeftovers } = this.reviewParts
    const { problems, foreign } = shadowReading(db, REVIEW_READS)
    recordForeignDivergences(db, this.actor, this.ts(), foreign)
    if (problems.length > 0)
      throw new ShadowNotClean(problems)
    if (clearLeftovers !== undefined)
      recordLeftovers(db, this.actor, this.ts(), clearLeftovers())
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return reviewCandidates(this.db, this.ts()).filter(task => inScope(task, scope))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return reviewCandidates(this.db, ts)
  }

  protected handle(lease: Lease): Promise<Step> {
    return this.executor.review(lease)
  }

  protected override pauseAfter(step: Step): number {
    return step.kind === 'recorded' ? 0 : step.kind === 'idle' ? CHECK_MS : TICK_MS
  }

  protected override stepLine(step: Step): string | null {
    const line = stepLine(step)
    return line === null ? null : line.slice(PREFIX.length)
  }
}

export class ReviewWorker {
  readonly actor: string
  private readonly executor: ReviewExecutor

  constructor(private readonly parts: WorkerParts) {
    this.actor = `worker:review:${parts.session}`
    this.executor = new ReviewExecutor(parts)
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  async step(): Promise<Step> {
    expireLeases(this.parts.db, this.ts())
    const lease = leaseNext(this.parts.db, this.ts(), 'review', this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.review(lease)
  }

  async stepOn(key: string): Promise<Step> {
    expireLeases(this.parts.db, this.ts())
    const lease = leaseQueued(this.parts.db, this.ts(), key, this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.review(lease)
  }
}

export function startReviewWorkers(parts: WorkerParts, slots: number): ReviewWorker[] {
  const { problems } = shadowReading(parts.db)
  if (problems.length > 0)
    throw new ShadowNotClean(problems)
  return Array.from({ length: slots }, (_, slot) => new ReviewWorker({ ...parts, session: `${parts.session}-${slot + 1}` }))
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

export type KeepDryRun = (session: string, record: DryRunRecord) => void

const NO_CARD_BODY: CardBodyOf = () => null

export function busCardBody(busPath: string): CardBodyOf {
  return (cardId) => {
    if (!existsSync(busPath))
      return null
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return cardBodyShaOfCard(db, cardId)
    }
    finally {
      db.close()
    }
  }
}

const LIVE_REVIEW_LEASES = `SELECT task_key, card_id, lease_gen FROM tasks WHERE queue = 'review' AND state = '${LEASED}'`

const SESSIONS_UNDER_A_LEASE = `
  SELECT DISTINCT json_extract(payload, '$.session') AS session FROM events
  WHERE dedupe_key >= ? AND dedupe_key < ? AND legacy = 0 AND json_valid(payload)
    AND json_extract(payload, '$.task_key') = ? AND json_extract(payload, '$.lease_gen') = ?
`

function heartbeatKeysOf(cardId: number): [string, string] {
  return [`${SESSION_HEARTBEAT}:${cardId}:`, `${SESSION_HEARTBEAT}:${cardId};`]
}

export function sessionsUnderLiveLeases(db: DatabaseSync): Set<string> {
  const leases = db.prepare(LIVE_REVIEW_LEASES).all() as { task_key: string, card_id: number, lease_gen: number }[]
  const sessions = leases.flatMap(lease => db.prepare(SESSIONS_UNDER_A_LEASE).all(...heartbeatKeysOf(lease.card_id), lease.task_key, lease.lease_gen) as { session: unknown }[])
  return new Set(sessions.flatMap(row => typeof row.session === 'string' ? [row.session] : []))
}

function busSessionsUnderLiveLeases(busPath: string): Set<string> {
  if (!existsSync(busPath))
    return new Set()
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return sessionsUnderLiveLeases(db)
  }
  finally {
    db.close()
  }
}

export function sparingLiveLeases(busPath: string, tools: TreeTools = GIT_TREE_TOOLS): TreeTools {
  return {
    ...tools,
    worktrees: (repo) => {
      const live = busSessionsUnderLiveLeases(busPath)
      return tools.worktrees(repo).filter(tree => !live.has(path.basename(tree)))
    },
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

function releasedLines(held: HeldTree): string[] {
  const left = held.release()
  return left === null ? [] : [`${PREFIX}the review tree ${held.path} was not removed: ${left}`]
}

export async function dryRun(gitHub: GitHub, reviewer: Reviewer, planner: ReviewPlanner, pr: number, cardBodyOf: CardBodyOf = NO_CARD_BODY, keep: KeepDryRun = () => {}): Promise<string[]> {
  const lease = dryRunLease(gitHub, pr, cardBodyOf)
  const plan = planned(planner, lease, null)
  let review: Review
  try {
    review = await reviewer(lease, plan)
  }
  catch (error) {
    if (error instanceof ReviewFailed) {
      for (const line of releasedLines(error.held))
        console.error(line)
    }
    throw error
  }
  keep(review.session, { pr, head: lease.head! })
  return [...dryRunLines(lease, plan, review), ...(review.tree === undefined ? [] : releasedLines(review.tree))]
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
  isolation: IsolationReader
  keepDryRun?: KeepDryRun
}

function ghOutput(port: GhPort, args: string[], call: GhCallOptions): string {
  const result = port.call(args, call)
  if (result.kind === 'failed')
    throw new GhFailed(result)
  return result.stdout
}

export function ghNotePr(cwd: string, port: GhPort = PROCESS_GH_PORT): (pr: number, line: string) => void {
  return (pr, line) => {
    const view = ghOutput(port, ['pr', 'view', String(pr), '--json', 'body', '-q', '.body'], { cwd })
    ghOutput(port, ['pr', 'edit', String(pr), '--body-file', '-'], { cwd, input: `${view.trimEnd()}\n\n${line}\n` })
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
    const isolation = run.isolation()
    if (isolation.level === 'none') {
      console.error(`${PREFIX}no runtime isolation: ${isolation.why}; nothing reviewed`)
      return 1
    }
    for (const line of await dryRun(run.gitHub, run.reviewer, run.plan, mode.pr, busCardBody(run.busPath), run.keepDryRun))
      console.log(line)
    return 0
  }
  const env = { ...process.env, [slotsVariable('review')]: String(run.slots) }
  const build = (db: DatabaseSync, detection: DetectionMode): ReviewNode => new ReviewNode({
    db,
    gitHub: run.gitHub,
    publish: run.publish,
    reviewer: run.reviewer,
    plan: run.plan,
    clock: () => new Date(),
    session: run.session,
    clearLeftovers: run.clearLeftovers,
    notePr: run.notePr,
    isolation: run.isolation,
    prompts: promptsDirOf(run.busPath),
    mode: detection,
    env,
  })
  try {
    return await runNode(argv, 'review', run.busPath, build, { pause: run.pause })
  }
  catch (error) {
    if (!(error instanceof ShadowNotClean))
      throw error
    console.error(`${PREFIX}refused to start, the shadow report is not clean:\n${error.problems.map(problem => `  ${problem}`).join('\n')}`)
    return 1
  }
}

export function reviewBeatLine(lease: Lease, session: string, ts: string): string {
  return `${PREFIX}${lease.taskKey}: reviewer session ${session} is working, heartbeat at ${ts}`
}

export function busReviewPulse(busPath: string, clock: () => Date, say: (line: string) => void = console.log, measure: SessionMeasure = measureSession): SessionPulse {
  const pulse = busSessionPulse(busPath, clock, measure)
  return (lease, session) => say(reviewBeatLine(lease, session, pulse(lease, session)))
}

export function reviewIsolationCommand(): string[] {
  return ['claude', ...HEADLESS_FLAGS]
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  const argv = process.argv.slice(2)
  const busPath = defaultBusPath()
  const trees = new ReviewTrees(cwd, reviewsDir(BUS_DIR, reviewMode(argv)), sparingLiveLeases(busPath))
  return runReview(argv, {
    busPath,
    gitHub: ghApi(cwd),
    publish: ghStatusPublisher(cwd),
    reviewer: claudeReviewer(trees, spawnSession, busReviewPulse(busPath, () => new Date())),
    plan: gitReviewPlanner(cwd, MORSE_JOURNAL, defaultParking(os.homedir())),
    session: randomUUID(),
    slots: slotsOf('review', process.env),
    pause: sleep,
    clearLeftovers: () => trees.clearLeftovers(),
    notePr: ghNotePr(cwd),
    isolation: realIsolationReader(process.env, cwd, reviewIsolationCommand()),
    keepDryRun: keepDryRun(trees.dir),
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
