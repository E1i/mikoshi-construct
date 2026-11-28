import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { DetectionMode, NodeDeclaration, Scope } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { StoredEvent } from '../../core/stored.js'
import type { ProcessCwds } from '../../ports/client/contract.js'
import type { FreedArtifact, RootSize } from './artifact-lifetimes.js'
import type { CardTreeRemover, CloseOutcome, ReportedVerification } from './close-executor.js'
import type { EndedTree } from './ended-card-trees.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { busDirOf } from '../../core/bus-path.js'
import { defaultBusPath } from '../../core/db.js'
import { CARD_VERIFIED, PR_CLOSED, PR_OPENED, REDUCED, WITNESS_RECORDED } from '../../core/events.js'
import { Node, prefixOf, runNode, UNDERSTOOD_NOW } from '../../core/node.js'
import { answerCardBodyOf, cardBodyShaOfCard, closeCandidates } from '../../core/queue.js'
import { loadedCodeSha } from '../../ports/git.js'
import { clientCwdsOf } from '../../ports/process-table.js'
import { candidateRules, clientAdapterOfTheBus, nodeLiveness, nodeSupply } from '../../supervisor/composition.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { alarmOverBudget, HOME_BUDGET_BYTES, recordFreedArtifacts, sweepArtifacts } from './artifact-lifetimes.js'
import { cardClosed, CloseExecutor, failureOf, probeClosingCardIds } from './close-executor.js'
import { cardTreeSweep, gitWorktrees, recordEndedTrees } from './ended-card-trees.js'
import { cardVerifiedClosings, closingVerificationOf, legacyLines } from './task-close.js'

export const PREFIX = prefixOf('close')
export const CLOSE_ON = [REDUCED, PR_CLOSED, PR_OPENED, CARD_VERIFIED, WITNESS_RECORDED] as const

export const CLOSE_NODE: NodeDeclaration = { kind: 'close', on: CLOSE_ON, understands: UNDERSTOOD_NOW }

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED])
const SCOPED_BY_PR_ON: ReadonlySet<string> = new Set([PR_CLOSED])

export type CloseStep = CloseOutcome

export interface CloseNodeParts {
  db: DatabaseSync
  reported: ReportedVerification
  clock: () => Date
  session: string
  parking: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  silentMs: number
  trees?: CardTreeRemover
  cwds?: () => ProcessCwds
  endedTrees?: () => EndedTree[]
  artifacts?: () => FreedArtifact[]
  home?: HomeWatch
}

export interface HomeWatch {
  path: string
  budget: number
  everyMs: number
  sizes?: (home: string) => RootSize[]
}

export const HOME_MEASURED_EVERY_MS = 60 * 60 * 1000

function probeCandidates(db: DatabaseSync): QueuedTask[] {
  return probeClosingCardIds(db).map(cardId => reportCloseTask(db, cardId))
}

function reportCloseTask(db: DatabaseSync, cardId: number): QueuedTask {
  const cardBody = cardClosed(db, cardId) ? answerCardBodyOf({ card_body: cardBodyShaOfCard(db, cardId) }) : undefined
  return cardBody === undefined ? { queue: 'close', cardId } : { queue: 'close', cardId, cardBody }
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

export class CloseNode extends Node<CloseStep> {
  private readonly executor: CloseExecutor
  private homeMeasuredAt: number | null = null

  constructor(private readonly closeParts: CloseNodeParts) {
    super('close', { db: closeParts.db, clock: closeParts.clock, session: closeParts.session, mode: closeParts.mode, env: closeParts.env, silentMs: closeParts.silentMs, supply: nodeSupply() })
    this.executor = new CloseExecutor({ db: closeParts.db, cards: this.suppliedCards, reported: closeParts.reported, clock: closeParts.clock, parking: closeParts.parking, silentMs: closeParts.silentMs, trees: closeParts.trees, cwds: closeParts.cwds })
    this.declare(CLOSE_NODE, scopeOf)
  }

  freeEndedTrees(): void {
    if (this.closeParts.endedTrees === undefined)
      return
    try {
      recordEndedTrees(this.db, this.actor, this.ts(), this.closeParts.endedTrees())
    }
    catch (error) {
      console.error(`${PREFIX}the pass over ended cards' trees failed, the close goes on: ${failureOf(error)}`)
    }
  }

  freeEndedArtifacts(): void {
    if (this.closeParts.artifacts === undefined)
      return
    try {
      recordFreedArtifacts(this.db, this.actor, this.ts(), this.closeParts.artifacts())
    }
    catch (error) {
      console.error(`${PREFIX}the pass over ended artifacts failed, the close goes on: ${failureOf(error)}`)
    }
  }

  measureHome(): void {
    const home = this.closeParts.home
    const now = this.closeParts.clock().getTime()
    if (home === undefined || (this.homeMeasuredAt !== null && now - this.homeMeasuredAt < home.everyMs))
      return
    this.homeMeasuredAt = now
    try {
      alarmOverBudget(this.db, this.actor, this.ts(), home.path, home.budget, home.sizes)
    }
    catch (error) {
      console.error(`${PREFIX}measuring the construct home failed, the close goes on: ${failureOf(error)}`)
    }
  }

  private keepTheHome(): void {
    this.freeEndedTrees()
    this.freeEndedArtifacts()
    this.measureHome()
  }

  protected override before(): void {
    this.keepTheHome()
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return [...closeCandidates(this.db, this.ts(), candidateRules()), ...probeCandidates(this.db)].filter(task => inScope(task, scope))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return [...closeCandidates(this.db, ts, candidateRules()), ...probeCandidates(this.db)]
  }

  protected handle(lease: Lease): CloseStep {
    this.keepTheHome()
    const outcome = this.executor.close(lease)
    if (outcome.kind === 'closed' && outcome.cycle.treeLeft !== null)
      recordEndedTrees(this.db, this.actor, this.ts(), [{ cardId: lease.cardId, ...outcome.cycle.treeLeft }])
    return outcome
  }

  protected override stepLine(step: CloseStep): string | null {
    if (step.kind !== 'closed')
      return super.stepLine(step)
    return `${step.taskKey}: closed, verification ${step.verification}; card file ${step.cycle.cardFile}${step.cycle.treeLeft === null ? '' : `; tree left at ${step.cycle.treeLeft.path}: ${step.cycle.treeLeft.left}`}`
  }
}

export function closingVerification(busPath: string): ReportedVerification {
  return (cardId, pr) => pr === null ? null : closingVerificationOf(legacyLines(busPath), cardVerifiedClosings(busPath), String(cardId), pr)
}

export interface CloseRun {
  busPath: string
  reported: ReportedVerification
  session: string
  parking: string
  pause: (ms: number) => Promise<unknown>
  cwds?: () => ProcessCwds
  endedTrees?: (db: DatabaseSync) => () => EndedTree[]
  artifacts?: (db: DatabaseSync) => () => FreedArtifact[]
  home?: HomeWatch
}

export function closeNodeOf(run: CloseRun, db: DatabaseSync, mode: DetectionMode, clock: () => Date = () => new Date()): CloseNode {
  return new CloseNode({ ...nodeLiveness(), db, reported: run.reported, clock, session: run.session, parking: run.parking, mode, env: process.env, cwds: run.cwds, endedTrees: run.endedTrees?.(db), artifacts: run.artifacts?.(db), home: run.home })
}

export async function runCloseWorker(argv: string[], run: CloseRun): Promise<number> {
  return runNode(argv, 'close', run.busPath, (db, mode) => closeNodeOf(run, db, mode), { pause: run.pause, codeSha: loadedCodeSha, supply: nodeSupply() })
}

async function main(): Promise<number> {
  const construct = path.join(os.homedir(), '.construct')
  const repo = process.cwd()
  const busPath = defaultBusPath()
  const places = { home: construct, busDir: busDirOf(busPath) }
  const cwds = clientCwdsOf(clientAdapterOfTheBus().processes)
  const endedTrees = (db: DatabaseSync) => {
    const trees = cardTreeSweep(db, process.env, busPath, repo, gitWorktrees(repo), () => new Date(), cwds)
    return () => trees.free()
  }
  const artifacts = (db: DatabaseSync) => () => sweepArtifacts(db, places, gitWorktrees(repo), new Date())
  const home = { path: construct, budget: HOME_BUDGET_BYTES, everyMs: HOME_MEASURED_EVERY_MS }
  return runCloseWorker(process.argv.slice(2), { busPath, reported: closingVerification(busPath), session: randomUUID(), parking: path.join(construct, 'parking'), pause: sleep, cwds, endedTrees, artifacts, home })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
