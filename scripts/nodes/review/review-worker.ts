import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { CardTransitions, Lease } from '../../core/lease.js'
import type { DetectionMode, NodeDeclaration, Scope } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { ReadSet } from '../../core/report.js'
import type { StoredEvent } from '../../core/stored.js'
import type { GhCallOptions, GhPort } from '../../ports/gh.js'
import type { StatusPublisher } from '../../ports/github-status.js'
import type { GitHub } from '../../ports/github.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { CardSessionMeasure } from '../../supervisor/composition.js'
import type { DryRunRecord } from './dry-run-record.js'
import type { RoundLimitRecut } from './pr-close.js'
import type { EarlierVerdict, ReviewPlan, ReviewPlanner } from './review-depth.js'
import type { ExecutorParts, ReviewPlannerLater, Step } from './review-executor.js'
import type { CardDecision, HeldTree, LeftoverTree, PrBodyOf, Review, Reviewer, SessionPulse, TreeTools } from './reviewer.js'
import type { TailIntake } from './tail-card.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { textSha } from '../../../src/card/text-sha.js'
import { defaultBusDir } from '../../core/bus-path.js'
import { closedWaitIds } from '../../core/card-readings.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../../core/db.js'
import { events } from '../../core/events-query.js'
import { CARD_ADMITTED, PR_CLOSED, PR_OBSERVED, PR_OPENED, REDUCED, REVIEW_RECORDED, SESSION_HEARTBEAT, TASK_COMPLETED, TASK_ENQUEUED, TASK_EXPIRED, TASK_FAILED, TASK_RELEASED, TASK_REQUEUED, TASK_SUPERSEDED } from '../../core/events.js'
import { prOf, reviewInputOf, reviewInputOfKey, taskKey } from '../../core/identifiers.js'
import { expireLeases, leaseNext, leaseQueued } from '../../core/lease.js'
import { DRY_RUN_ACTOR, Node, runNode, SWITCH_FLAG, UNDERSTOOD_NOW } from '../../core/node.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { pushPolicyOf } from '../../core/push-policy.js'
import { cardBodyShaOfCard, LEASED, reviewCandidates } from '../../core/queue.js'
import { shadowReading } from '../../core/report.js'
import { openDatabase } from '../../core/sqlite.js'
import { ofQueue as tasksOfQueue } from '../../core/tasks-query.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { namesCard } from '../../policy/decisions/decisions.js'
import { decisionsInForceAt } from '../../policy/shards.js'
import { GhFailed, PROCESS_GH_PORT } from '../../ports/gh.js'
import { loadedCodeSha, readThroughPort } from '../../ports/git.js'
import { ghStatusPublisher } from '../../ports/github-status.js'
import { ghApi, ghApiPatch, ghApiPost } from '../../ports/github.js'
import { cardIdOfDescription, isFullSha, prBodySha } from '../../ports/identifier-shapes.js'
import { realIsolationReader } from '../../ports/isolation.js'
import { promptsDirOf } from '../../ports/prompt-store.js'
import { plannerProcess, REVIEW_PLAN_FLAG } from '../../ports/review-planner.js'
import { clientAdapter, spawnReviewSession } from '../../ports/session.js'
import { busProjections, candidateRules, cardSessionPulse, cardStatesOfTheBus, cardTransitions, nodeLiveness, nodeSupply, planOfCard, pullRequests, requiredCheckAt, withSlots } from '../../supervisor/composition.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { busUnstartedTails, gitReviewPlanner } from './depth-sources.js'
import { recordForeignDivergences } from './divergence-alarm.js'
import { dryRunReviewsDir, keepDryRun } from './dry-run-record.js'
import { RoundLimitRecutter } from './pr-close.js'
import { planned, recordLeftovers, ReviewExecutor } from './review-executor.js'
import { claudeReviewer, GIT_TREE_TOOLS, PREFIX, REVIEW_BEAT_MS, ReviewFailed, ReviewTrees } from './reviewer.js'
import { BusTailIntake } from './tail-card.js'

export { earlierVerdict, planned, recordLeftovers, REVIEW_ROUNDS_SPENT, ROUND_LIMIT_REACHED, roundLimitLine, SPAWNS_NO_SESSION } from './review-executor.js'
export type { Step }

const WORKER_SCRIPT = fileURLToPath(import.meta.url)

export interface PlanRequest {
  lease: Lease
  earlier: EarlierVerdict | null
}

function planOfOutput(stdout: string): ReviewPlan {
  const last = stdout.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1)
  if (last === undefined)
    throw new Error('the planning process printed no plan')
  return JSON.parse(last) as ReviewPlan
}

export function childReviewPlanner(cwd: string): ReviewPlannerLater {
  return async (lease, earlier, signal) => planOfOutput(await plannerProcess(cwd, JSON.stringify({ lease, earlier } satisfies PlanRequest), signal))
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

export function planInThisProcess(planner: ReviewPlanner, request: string, write: (text: string) => void): number {
  const { lease, earlier } = JSON.parse(request) as PlanRequest
  write(`\n${JSON.stringify(planner(lease, earlier))}\n`)
  return 0
}

export const DRY_RUN_FLAG = '--dry-run'
const BUS_DIR = defaultBusDir()
const MORSE_JOURNAL = path.join(BUS_DIR, 'morse.jsonl')

function busReviewPlanner(cwd: string, busPath: string): ReviewPlanner {
  return gitReviewPlanner(cwd, MORSE_JOURNAL, busCardBodies(busPath))
}

const PLANNER_REFUSED = 2

export async function planLeaseOnStdin(cwd: string, argv: readonly string[]): Promise<number> {
  if (!argv.includes(REVIEW_PLAN_FLAG))
    return PLANNER_REFUSED
  return planInThisProcess(busReviewPlanner(cwd, defaultBusPath()), await stdinText(), text => process.stdout.write(text))
}

export const REVIEW_ON = [REDUCED, PR_OBSERVED, PR_CLOSED, PR_OPENED, REVIEW_RECORDED, CARD_ADMITTED, TASK_ENQUEUED, TASK_REQUEUED, TASK_SUPERSEDED, TASK_COMPLETED, TASK_FAILED, TASK_RELEASED, TASK_EXPIRED] as const

export const REVIEW_NODE: NodeDeclaration = { kind: 'review', on: REVIEW_ON, understands: UNDERSTOOD_NOW }

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED])
const SCOPED_BY_CARD_ON: ReadonlySet<string> = new Set([CARD_ADMITTED])

export const REVIEW_READS: ReadSet = new Set(['prs', 'tasks', 'cards', 'card_bodies', 'mains', 'chains'])

export interface WorkerParts extends Omit<ExecutorParts, 'cards' | 'requiredCheck'> {
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

export function cardBodyOfKey(db: DatabaseSync, lease: Lease, held: string | null): string | null {
  const named = reviewInputOfKey(lease.taskKey)?.cardBody ?? null
  if (named === null)
    return held
  const admitted = events(db, { types: [CARD_ADMITTED], card: lease.cardId, valid: true, newestFirst: true })
    .map(row => row.data ?? {})
    .find(payload => payload.bodySha === named && typeof payload.text === 'string')
  return admitted !== undefined && admitted.textSha === textSha(admitted.text as string) ? admitted.text as string : null
}

export function decisionsOnTheCard(db: DatabaseSync, cardId: number, now: Date, pr: number | null = null): CardDecision[] {
  return decisionsInForceAt(db, now).filter(decision => namesCard(decision, cardId, pr)).map(({ decisionId, text }) => ({ decisionId, text }))
}

function readingTheKeyedBody<P extends ExecutorParts>(parts: P): P {
  return { ...parts, reviewer: (lease, plan, card, proven) => parts.reviewer(lease, plan, cardBodyOfKey(parts.db, lease, card ?? null), proven, decisionsOnTheCard(parts.db, lease.cardId, parts.clock(), lease.pr)) }
}

export interface ReviewNodeParts extends Omit<ExecutorParts, 'cards' | 'requiredCheck'> {
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
}

export class ReviewNode extends Node<Step> {
  private readonly executor: ReviewExecutor

  constructor(private readonly reviewParts: ReviewNodeParts) {
    super('review', { db: reviewParts.db, clock: reviewParts.clock, session: reviewParts.session, mode: reviewParts.mode, env: reviewParts.env, silentMs: reviewParts.silentMs, supply: nodeSupply() })
    this.executor = new ReviewExecutor(readingTheKeyedBody({ ...reviewParts, cards: this.suppliedCards, requiredCheck: () => requiredCheckAt() }))
    this.declare(REVIEW_NODE, scopeOf)
  }

  protected override renewsByTimer(): boolean {
    return false
  }

  protected override before(): void {
    const { db, clearLeftovers } = this.reviewParts
    const { problems, foreign } = shadowReading(db, busProjections(), REVIEW_READS)
    recordForeignDivergences(db, this.actor, this.ts(), foreign)
    if (problems.length > 0)
      throw new ShadowNotClean(problems)
    if (clearLeftovers !== undefined)
      recordLeftovers(db, this.actor, this.ts(), clearLeftovers())
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return reviewCandidates(this.db, this.ts(), candidateRules()).filter(task => inScope(task, scope))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return reviewCandidates(this.db, ts, candidateRules())
  }

  protected handle(lease: Lease): Promise<Step> {
    return this.executor.review(lease)
  }

  protected override pauseAfter(step: Step): number {
    return step.kind === 'recorded' ? 0 : super.pauseAfter(step)
  }

  protected override stepLine(step: Step): string | null {
    const line = stepLine(step)
    return line === null ? null : line.slice(PREFIX.length)
  }
}

export class ReviewWorker {
  readonly actor: string
  private readonly executor: ReviewExecutor
  private readonly cards: CardTransitions = cardTransitions()

  constructor(private readonly parts: WorkerParts) {
    this.actor = `worker:review:${parts.session}`
    this.executor = new ReviewExecutor(readingTheKeyedBody({ ...parts, cards: this.cards, requiredCheck: () => requiredCheckAt() }))
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  async step(): Promise<Step> {
    expireLeases(this.parts.db, this.cards, this.ts(), this.parts.silentMs)
    const lease = leaseNext(this.parts.db, pullRequests(this.parts.db), this.ts(), 'review', this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.review(lease)
  }

  async stepOn(key: string): Promise<Step> {
    expireLeases(this.parts.db, this.cards, this.ts(), this.parts.silentMs)
    const lease = leaseQueued(this.parts.db, this.ts(), key, this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.review(lease)
  }
}

export function startReviewWorkers(parts: WorkerParts, slots: number): ReviewWorker[] {
  const { problems } = shadowReading(parts.db, busProjections())
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
  return mode.kind === 'dry-run' ? dryRunReviewsDir(busDir) : path.join(busDir, 'reviews')
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

function heartbeatKeyPrefixOf(cardId: number): string {
  return `${SESSION_HEARTBEAT}:${cardId}:`
}

export function sessionsUnderLiveLeases(db: DatabaseSync): Set<string> {
  const leases = tasksOfQueue(db, 'review').filter(task => task.state === LEASED)
  const sessions = leases.flatMap(lease => events(db, { keyPrefix: heartbeatKeyPrefixOf(lease.card_id), task: lease.task_key })
    .filter(beat => beat.data?.lease_gen === lease.lease_gen)
    .map(beat => beat.data?.session))
  return new Set(sessions.flatMap(session => typeof session === 'string' ? [session] : []))
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

export function gitHubPrBody(gitHub: GitHub): PrBodyOf {
  return (pr) => {
    const response = gitHub(`repos/{owner}/{repo}/pulls/${pr}`)
    const body = response.status === 200 ? (response.body as { body?: unknown }).body : null
    return typeof body === 'string' ? body : null
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
  planLater?: ReviewPlannerLater
  session: string
  slots: number
  pause: (ms: number) => Promise<unknown>
  clearLeftovers: () => LeftoverTree[]
  notePr?: (pr: number, line: string) => void
  isolation: IsolationReader
  keepDryRun?: KeepDryRun
  recut?: (db: DatabaseSync) => RoundLimitRecut
  tail?: (db: DatabaseSync) => TailIntake
}

function ghOutput(port: GhPort, args: string[], call: GhCallOptions): string {
  const result = port.call(args, call)
  if (result.kind === 'failed')
    throw new GhFailed(result)
  return result.stdout
}

export function ghNotePr(cwd: string, port: GhPort = PROCESS_GH_PORT, pushPolicy?: () => PushPolicy): (pr: number, line: string) => void {
  return (pr, line) => {
    if (pushPolicy?.() === 'none')
      return
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
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG} once ${pnpmCommand('bus:report')} is clean`)
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
  const env = withSlots('review', process.env, run.slots)
  const build = (db: DatabaseSync, detection: DetectionMode): ReviewNode => new ReviewNode({
    ...nodeLiveness(),
    db,
    gitHub: run.gitHub,
    publish: run.publish,
    reviewer: run.reviewer,
    plan: run.planLater ?? run.plan,
    clock: () => new Date(),
    session: run.session,
    clearLeftovers: run.clearLeftovers,
    notePr: run.notePr,
    isolation: run.isolation,
    recut: run.recut?.(db),
    tail: run.tail?.(db),
    prompts: promptsDirOf(run.busPath),
    mode: detection,
    env,
  })
  try {
    return await runNode(argv, 'review', run.busPath, build, { pause: run.pause, codeSha: loadedCodeSha, supply: nodeSupply() })
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

export function busReviewPulse(busPath: string, clock: () => Date, say: (line: string) => void = console.log, measure?: CardSessionMeasure): SessionPulse {
  const pulse = cardSessionPulse(busPath, clock, measure)
  return (lease, session) => say(reviewBeatLine(lease, session, pulse(lease, session)))
}

export function reviewIsolationCommand(): string[] {
  return clientAdapter().processes.isolationCommand()
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  const argv = process.argv.slice(2)
  const busPath = defaultBusPath()
  stampLogOutput()
  const trees = new ReviewTrees(cwd, reviewsDir(BUS_DIR, reviewMode(argv)), sparingLiveLeases(busPath))
  return runReview(argv, {
    busPath,
    gitHub: ghApi(cwd),
    publish: ghStatusPublisher(cwd),
    reviewer: claudeReviewer(trees, spawnReviewSession, busReviewPulse(busPath, () => new Date()), REVIEW_BEAT_MS, gitHubPrBody(ghApi(cwd))),
    plan: busReviewPlanner(cwd, busPath),
    planLater: childReviewPlanner(cwd),
    session: randomUUID(),
    slots: nodeSupply().slotsOf('review', process.env),
    pause: sleep,
    clearLeftovers: () => trees.clearLeftovers(),
    notePr: ghNotePr(cwd, PROCESS_GH_PORT, () => pushPolicyOf(readThroughPort, cwd)),
    isolation: realIsolationReader(process.env, cwd, reviewIsolationCommand()),
    keepDryRun: keepDryRun(trees.dir),
    recut: db => new RoundLimitRecutter({ db, gitHub: ghApi(cwd), post: ghApiPost(cwd), patch: ghApiPatch(cwd), clock: () => new Date(), cardStates: () => cardStatesOfTheBus(db), closedWaits: () => closedWaitIds(db), planOfCard, pushPolicy: () => pushPolicyOf(readThroughPort, cwd) }),
    tail: db => new BusTailIntake({ db, gitHub: ghApi(cwd), clock: () => new Date(), cardStates: () => cardStatesOfTheBus(db), unstartedTails: busUnstartedTails(db) }),
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === WORKER_SCRIPT) {
  process.exitCode = await main()
}
