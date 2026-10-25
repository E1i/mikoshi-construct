import type { DatabaseSync } from 'node:sqlite'
import type { Priority } from '../../../src/card/parking.js'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, Lease, LeaseOrder } from '../../core/lease.js'
import type { DetectionMode, Scope, WaitStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { StoredEvent } from '../../core/stored.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { AnswerOutcome } from './answer-executor.js'
import type { Answerer, CardText } from './answerer.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../../src/card/parking.js'
import { defaultBusDir } from '../../core/bus-path.js'
import { defaultBusPath } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, DECISIONS_IMPORTED, MERGE_DONE, POLICY_DENIED, PR_CLOSED, PR_OBSERVED, PR_OPENED, REDUCED, REVIEW_RECORDED } from '../../core/events.js'
import { assertHeld, failTask, queuedCards, StaleLease } from '../../core/lease.js'
import { Node, runNode } from '../../core/node.js'
import { answerCandidates } from '../../core/queue.js'
import { cardContract, NOT_MINE, notMine } from '../../intake/card-contract.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { OWNER_MERGES } from '../../policy/policy.js'
import { realIsolationReader } from '../../ports/isolation.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { promptsDirOf } from '../../ports/prompt-store.js'
import { HEADLESS_FLAGS } from '../../ports/session.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { AnswerExecutor } from './answer-executor.js'
import { answerSourceOf } from './answer-source.js'
import { claudeAnswerer, PREFIX, realAnswererTools } from './answerer.js'

const ANSWERS_DIR = path.join(defaultBusDir(), 'answers')

export const ANSWER_ON = [REDUCED, PR_OBSERVED, PR_CLOSED, PR_OPENED, REVIEW_RECORDED, CARD_STOPPED, CARD_ANSWERED, CARD_STARTED, DECISION_RECORDED, DECISIONS_IMPORTED, MERGE_DONE] as const

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

export const VERDICT_NOT_RECORDED = 'verdict_not_recorded'

const CHANGES_RECORDED_ON_HEAD = `SELECT 1 FROM events WHERE type = '${REVIEW_RECORDED}' AND card_id = ? AND head = ? AND json_extract(payload, '$.verdict') = 'changes' LIMIT 1`

export type AnswerStep = AnswerOutcome | WaitStep | { kind: 'denied', taskKey: string, denial: NotMineDenial, next: AfterFailure } | { kind: 'faulted', taskKey: string, detail: string }

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
    this.subscribe(ANSWER_ON, scopeOf)
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

  private verdictNotRecordedYet(lease: Lease): boolean {
    return answerSourceOf(this.db, lease)?.kind === 'changes' && this.db.prepare(CHANGES_RECORDED_ON_HEAD).get(lease.cardId, lease.head) === undefined
  }

  private waitingForTheVerdict(lease: Lease): AnswerStep | null {
    return this.verdictNotRecordedYet(lease) ? this.waitOn(lease, VERDICT_NOT_RECORDED, new Date(this.answerParts.clock().getTime() + TICK_MS).toISOString()) : null
  }

  protected async handle(lease: Lease): Promise<AnswerStep> {
    try {
      return this.withdrawnIfNotMine(lease) ?? this.waitingForTheVerdict(lease) ?? await this.executor.answer(lease)
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
}

export function answerNodeOf(run: AnswerRun, db: DatabaseSync, mode: DetectionMode): AnswerNode {
  return new AnswerNode({ db, answerer: run.answerer, ownerMerges: run.ownerMerges, cardText: run.cardText, clock: () => new Date(), session: run.session, mode, env: process.env, isolation: run.isolation, prompts: promptsDirOf(run.busPath) })
}

export async function runAnswerWorker(argv: string[], run: AnswerRun): Promise<number> {
  return runNode(argv, 'answer', run.busPath, (db, mode) => answerNodeOf(run, db, mode), { pause: run.pause })
}

export function answerIsolationCommand(): string[] {
  return ['claude', ...HEADLESS_FLAGS]
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  const busPath = defaultBusPath()
  return runAnswerWorker(process.argv.slice(2), {
    busPath,
    answerer: claudeAnswerer(ANSWERS_DIR, realAnswererTools(busPath)),
    ownerMerges: () => readFileSync(path.join(cwd, OWNER_MERGES), 'utf8'),
    cardText: busCardBodies(busPath),
    session: randomUUID(),
    pause: sleep,
    isolation: realIsolationReader(process.env, cwd, answerIsolationCommand()),
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
