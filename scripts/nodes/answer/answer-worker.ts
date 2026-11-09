import type { DatabaseSync } from 'node:sqlite'
import type { Priority } from '../../../src/card/parking.js'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, Lease, LeaseOrder } from '../../core/lease.js'
import type { DetectionMode, NodeDeclaration, Scope, WaitStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { StoredEvent } from '../../core/stored.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { Answerer, CardText } from './answerer.js'
import type { AnswerOutcome, TreePublishing } from './duties/index.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { cardToolsOf, parseParkingFile } from '../../../src/card/parking.js'
import { defaultBusDir } from '../../core/bus-path.js'
import { bodyNotFoldedYet } from '../../core/card-bodies.js'
import { defaultBusPath } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, DECISIONS_IMPORTED, MERGE_DONE, POLICY_DENIED, PR_CLOSED, PR_OBSERVED, PR_OPENED, REDUCED, REVIEW_RECORDED } from '../../core/events.js'
import { assertHeld, failTask, queuedCards, StaleLease, supersedeLease } from '../../core/lease.js'
import { Node, runNode, UNDERSTOOD_NOW } from '../../core/node.js'
import { treeReportPath } from '../../core/places.js'
import { answerCandidates, pullRequestHeadPastTheAnswer, STALE_ANSWER_HEAD } from '../../core/queue.js'
import { cardContract, NOT_MINE, notMine } from '../../intake/card-contract.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { OWNER_MERGES } from '../../policy/policy.js'
import { clientAdapter } from '../../ports/client/index.js'
import { realIsolationReader } from '../../ports/isolation.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { promptsDirOf } from '../../ports/prompt-store.js'
import { CARD_SESSION_SANDBOX } from '../../ports/shift-settings.js'
import { MAIN_BRANCH } from '../../ports/snapshot.js'
import { launchDirOf, restoreReport, savedReportOf, treeHoldsACommit, treePrOfThisBuild, treePrPublisher } from '../../ports/tree-publish.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { AnswerExecutor } from './answer-executor.js'
import { answerSourceOf } from './answer-source.js'
import { claudeAnswerer, PREFIX, realAnswererTools } from './answerer.js'

const ANSWERS_DIR = path.join(defaultBusDir(), 'answers')

export const ANSWER_ON = [REDUCED, PR_OBSERVED, PR_CLOSED, PR_OPENED, REVIEW_RECORDED, CARD_STOPPED, CARD_ANSWERED, CARD_STARTED, CARD_ADMITTED, DECISION_RECORDED, DECISIONS_IMPORTED, MERGE_DONE] as const

export const ANSWER_NODE: NodeDeclaration = { kind: 'answer', on: ANSWER_ON, understands: UNDERSTOOD_NOW }

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED, DECISION_RECORDED, DECISIONS_IMPORTED, MERGE_DONE])
const SCOPED_BY_PR_ON: ReadonlySet<string> = new Set([PR_OBSERVED, PR_CLOSED, REVIEW_RECORDED])

export function priorityOf(cardText: CardText, cardId: number): Priority | null {
  const text = cardText(cardId)
  if (text === null)
    return null
  const parsed = parseParkingFile(`${cardId}.md`, text)
  return parsed.kind === 'parked' ? parsed.parked.priority : null
}

export function answerLeaseOrder(db: DatabaseSync, cardText: CardText): LeaseOrder {
  return { onePerCard: true, firstCards: queuedCards(db, 'answer').filter(cardId => priorityOf(cardText, cardId) === 'p0') }
}

export interface NotMineDenial {
  kind: 'technical'
  reason: typeof NOT_MINE
  detail: string
}

export interface StaleHeadDenial {
  kind: 'technical'
  reason: typeof STALE_ANSWER_HEAD
  detail: string
}

export const VERDICT_NOT_RECORDED = 'verdict_not_recorded'
export const AMEND_NOT_FOLDED = 'amend_not_folded'

const CHANGES_RECORDED_ON_HEAD = `SELECT 1 FROM events WHERE type = '${REVIEW_RECORDED}' AND card_id = ? AND head = ? AND json_extract(payload, '$.verdict') = 'changes' LIMIT 1`

export type AnswerStep = AnswerOutcome | WaitStep | { kind: 'denied', taskKey: string, denial: NotMineDenial | StaleHeadDenial, next: AfterFailure } | { kind: 'faulted', taskKey: string, detail: string }

export interface AnswerNodeParts {
  db: DatabaseSync
  answerer: Answerer
  ownerMerges: () => string
  clock: () => Date
  session: string
  cardText: CardText
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  trees?: CardTreeTools
  isolation?: IsolationReader
  prompts?: string
  publishing?: TreePublishing
}

export function treePublishing(treePr: string, launchDir: string, env: NodeJS.ProcessEnv): TreePublishing {
  const publish = treePrPublisher(treePr, launchDir, env)
  return {
    committed: card => treeHoldsACommit(card.worktree, `origin/${MAIN_BRANCH}`),
    publish: (card, cardId) => {
      if (!existsSync(treeReportPath(card.worktree)))
        restoreReport(savedReportOf(launchDir, cardId), card.worktree)
      publish(card.worktree, cardId)
    },
  }
}

function scopeOf(event: StoredEvent): Scope | undefined {
  if (WHOLE_QUEUE_ON.has(event.type))
    return undefined
  if (SCOPED_BY_PR_ON.has(event.type))
    return { pr: event.pr ?? undefined }
  return { cardId: event.card_id ?? undefined }
}

function inScope(task: QueuedTask, scope: Scope): boolean {
  return (scope.pr === undefined || task.pr === scope.pr) && (scope.cardId === undefined || task.cardId === scope.cardId)
}

export class AnswerNode extends Node<AnswerStep> {
  private readonly executor: AnswerExecutor

  constructor(private readonly answerParts: AnswerNodeParts) {
    super('answer', { db: answerParts.db, clock: answerParts.clock, session: answerParts.session, mode: answerParts.mode, env: answerParts.env })
    this.executor = new AnswerExecutor(answerParts)
    this.declare(ANSWER_NODE, scopeOf)
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return answerCandidates(this.db, this.ts()).filter(task => inScope(task, scope))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return answerCandidates(this.db, ts)
  }

  protected override leaseOrder(): LeaseOrder {
    return answerLeaseOrder(this.db, this.answerParts.cardText)
  }

  private withdrawnIfNotMine(lease: Lease): AnswerStep | null {
    try {
      assertHeld(this.db, lease)
      const detail = notMine(cardContract(this.db, lease.cardId), 'answer')
      if (detail === null)
        return null
      const denial: NotMineDenial = { kind: 'technical', reason: NOT_MINE, detail }
      const ts = this.ts()
      const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'answer', ...denial }, legacy: false }
      const next = failTask(this.db, ts, lease, { reason: NOT_MINE, withdraw: true }, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next }
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private supersededOnAStaleHead(lease: Lease): AnswerStep | null {
    const head = pullRequestHeadPastTheAnswer(this.db, lease.taskKey)
    if (head === null)
      return null
    const denial: StaleHeadDenial = { kind: 'technical', reason: STALE_ANSWER_HEAD, detail: `pull request #${lease.pr} moved from ${lease.head} to ${head} before this answer ran; no session runs on the old head and no review round is spent` }
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'answer', ...denial }, legacy: false }
    return { kind: 'denied', taskKey: lease.taskKey, denial, next: supersedeLease(this.db, ts, lease, [event]) }
  }

  private verdictNotRecordedYet(lease: Lease): boolean {
    return answerSourceOf(this.db, lease)?.kind === 'changes' && this.db.prepare(CHANGES_RECORDED_ON_HEAD).get(lease.cardId, lease.head) === undefined
  }

  private waitingForTheVerdict(lease: Lease): AnswerStep | null {
    return this.verdictNotRecordedYet(lease) ? this.waitOn(lease, VERDICT_NOT_RECORDED, new Date(this.answerParts.clock().getTime() + TICK_MS).toISOString()) : null
  }

  private waitingForTheAmend(lease: Lease): AnswerStep | null {
    return bodyNotFoldedYet(this.db, lease.cardId) ? this.waitOn(lease, AMEND_NOT_FOLDED, new Date(this.answerParts.clock().getTime() + TICK_MS).toISOString()) : null
  }

  protected async handle(lease: Lease): Promise<AnswerStep> {
    try {
      return this.withdrawnIfNotMine(lease) ?? this.supersededOnAStaleHead(lease) ?? this.waitingForTheAmend(lease) ?? this.waitingForTheVerdict(lease) ?? await this.executor.answer(lease)
    }
    catch (error) {
      const detail = messageOf(error)
      console.error(`${PREFIX}${this.actor}: the round on ${lease.taskKey} threw, its lease lapses and is expired as a failure; the other slots go on: ${detail}`)
      return { kind: 'faulted', taskKey: lease.taskKey, detail }
    }
  }

  protected override stepLine(step: AnswerStep): string | null {
    if (step.kind === 'answered')
      return `${step.taskKey}: answered in ${step.resumed ? 'the card session' : 'a new session'} ${step.session}; the head is ${step.head}`
    if (step.kind === 'published')
      return `${step.taskKey}: the session ${step.session} left a committed tree with no pull request; tree-pr opened PR #${step.pr}`
    if (step.kind === 'stopped')
      return `${step.taskKey}: card.stopped (${step.reason}): ${step.detail}`
    if (step.kind === 'decided')
      return `${step.taskKey}: decided under shard ${step.shard}, the card goes on: ${step.question}`
    if (step.kind === 'denied')
      return `${step.taskKey}: denied (${step.denial.kind}, ${step.denial.reason}): ${step.denial.detail}; the task is ${step.next}`
    if (step.kind === 'faulted')
      return null
    return super.stepLine(step)
  }
}

export interface AnswerRun {
  busPath: string
  answerer: Answerer
  ownerMerges: () => string
  cardText: CardText
  session: string
  pause: (ms: number) => Promise<unknown>
  isolation: IsolationReader
  publishing?: TreePublishing
}

export function answerNodeOf(run: AnswerRun, db: DatabaseSync, mode: DetectionMode): AnswerNode {
  return new AnswerNode({ db, answerer: run.answerer, ownerMerges: run.ownerMerges, cardText: run.cardText, clock: () => new Date(), session: run.session, mode, env: process.env, isolation: run.isolation, prompts: promptsDirOf(run.busPath), publishing: run.publishing })
}

export async function runAnswerWorker(argv: string[], run: AnswerRun): Promise<number> {
  return runNode(argv, 'answer', run.busPath, (db, mode) => answerNodeOf(run, db, mode), { pause: run.pause })
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  const busPath = defaultBusPath()
  return runAnswerWorker(process.argv.slice(2), {
    busPath,
    answerer: claudeAnswerer(ANSWERS_DIR, { ...realAnswererTools(busPath), cardTools: (cardId, cardBody) => cardToolsOf(`${cardId}.md`, cardBody) }),
    ownerMerges: () => readFileSync(path.join(cwd, OWNER_MERGES), 'utf8'),
    cardText: busCardBodies(busPath),
    session: randomUUID(),
    pause: sleep,
    isolation: realIsolationReader(process.env, cwd, clientAdapter().processes.isolationCommand(), { sandbox: CARD_SESSION_SANDBOX }),
    publishing: treePublishing(treePrOfThisBuild(cwd), launchDirOf(os.homedir(), busPath), process.env),
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
