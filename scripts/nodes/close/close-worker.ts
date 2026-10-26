import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { DetectionMode, Scope } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { StoredEvent } from '../../core/stored.js'
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
import { Node, prefixOf, runNode } from '../../core/node.js'
import { closeCandidates } from '../../core/queue.js'
import { DEFAULT_WORKTREE_HOME, worktreeHome } from '../../ports/worktree-home.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { CloseExecutor, failureOf, probeClosingCardIds } from './close-executor.js'
import { EndedCardTrees, gitWorktrees, recordEndedTrees } from './ended-card-trees.js'
import { cardVerifiedClosings, closingVerificationOf, legacyLines } from './task-close.js'

export const PREFIX = prefixOf('close')
export const CLOSE_ON = [REDUCED, PR_CLOSED, PR_OPENED, CARD_VERIFIED, WITNESS_RECORDED] as const

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
  trees?: CardTreeRemover
  endedTrees?: () => EndedTree[]
}

function probeCandidates(db: DatabaseSync): QueuedTask[] {
  return probeClosingCardIds(db).map(cardId => ({ queue: 'close', cardId }))
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

  constructor(private readonly closeParts: CloseNodeParts) {
    super('close', { db: closeParts.db, clock: closeParts.clock, session: closeParts.session, mode: closeParts.mode, env: closeParts.env })
    this.executor = new CloseExecutor({ db: closeParts.db, reported: closeParts.reported, clock: closeParts.clock, parking: closeParts.parking, trees: closeParts.trees })
    this.subscribe(CLOSE_ON, scopeOf)
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

  protected override before(): void {
    this.freeEndedTrees()
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return [...closeCandidates(this.db, this.ts()), ...probeCandidates(this.db)].filter(task => inScope(task, scope))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return [...closeCandidates(this.db, ts), ...probeCandidates(this.db)]
  }

  protected handle(lease: Lease): CloseStep {
    this.freeEndedTrees()
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
  endedTrees?: (db: DatabaseSync) => () => EndedTree[]
}

export async function runCloseWorker(argv: string[], run: CloseRun): Promise<number> {
  return runNode(argv, 'close', run.busPath, (db, mode) => new CloseNode({ db, reported: run.reported, clock: () => new Date(), session: run.session, parking: run.parking, mode, env: process.env, endedTrees: run.endedTrees?.(db) }), { pause: run.pause })
}

export function cardTreeRoots(env: NodeJS.ProcessEnv, busPath: string, repo: string): { homes: string[], perBus: string } {
  const perBus = path.join(busDirOf(busPath), 'worktrees')
  return { homes: [worktreeHome(env), DEFAULT_WORKTREE_HOME, perBus, path.dirname(repo)], perBus }
}

async function main(): Promise<number> {
  const construct = path.join(os.homedir(), '.construct')
  const repo = process.cwd()
  const endedTrees = (db: DatabaseSync) => {
    const roots = cardTreeRoots(process.env, defaultBusPath(), repo)
    const trees = new EndedCardTrees(db, roots.homes, gitWorktrees(repo), () => new Date(), [roots.perBus])
    return () => trees.free()
  }
  const busPath = defaultBusPath()
  return runCloseWorker(process.argv.slice(2), { busPath, reported: closingVerification(busPath), session: randomUUID(), parking: path.join(construct, 'parking'), pause: sleep, endedTrees })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
