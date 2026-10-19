import type { DatabaseSync } from 'node:sqlite'
import type { Priority } from '../../src/card/parking.js'
import type { IsolationReader } from '../ghosts/isolation.js'
import type { AnswerOutcome } from './answer-executor.js'
import type { Answerer, CardText } from './answerer.js'
import type { CardTreeTools } from './card-tree.js'
import type { Lease, LeaseOrder } from './lease.js'
import type { DetectionMode, Scope } from './node.js'
import type { QueuedTask } from './queue.js'
import type { StoredEvent } from './stored.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { defaultParking } from '../ghosts/handoff-check.js'
import { realIsolationReader } from '../ghosts/isolation.js'
import { HEADLESS_FLAGS } from '../ghosts/session.js'
import { AnswerExecutor } from './answer-executor.js'
import { claudeAnswerer, parkedCardText, PREFIX, realAnswererTools } from './answerer.js'
import { MERGE_DONE, PR_OPENED, REVIEW_RECORDED } from './card-automaton.js'
import { defaultBusPath } from './db.js'
import { DECISIONS_IMPORTED } from './decisions.js'
import { messageOf } from './errors.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED } from './inbox.js'
import { queuedCards } from './lease.js'
import { Node, runNode } from './node.js'
import { PR_CLOSED } from './observations.js'
import { PR_OBSERVED } from './operator-work.js'
import { OWNER_MERGES } from './policy.js'
import { promptsDirOf } from './prompt-store.js'
import { answerCandidates } from './queue.js'
import { REDUCED } from './reducer.js'

const ANSWERS_DIR = path.join(os.homedir(), '.construct', 'bus', 'answers')

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

export type AnswerStep = AnswerOutcome | { kind: 'faulted', taskKey: string, detail: string }

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
    this.subscribe(ANSWER_ON, event => this.detectOn(event, scopeOf(event)))
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

  protected async handle(lease: Lease): Promise<AnswerStep> {
    try {
      return await this.executor.answer(lease)
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
  const parking = defaultParking(os.homedir())
  return runAnswerWorker(process.argv.slice(2), {
    busPath: defaultBusPath(),
    answerer: claudeAnswerer(ANSWERS_DIR, realAnswererTools(parking)),
    ownerMerges: () => readFileSync(path.join(cwd, OWNER_MERGES), 'utf8'),
    cardText: parkedCardText(parking),
    session: randomUUID(),
    pause: sleep,
    isolation: realIsolationReader(process.env, cwd, answerIsolationCommand()),
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
