import type { DatabaseSync } from 'node:sqlite'
import type { CardTreeRemover, CloseOutcome, ReportedVerification } from './close-executor.js'
import type { EndedTree } from './ended-card-trees.js'
import type { Lease } from './lease.js'
import type { DetectionMode, Scope } from './node.js'
import type { QueuedTask } from './queue.js'
import type { StoredEvent } from './stored.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CARD_VERIFIED, cardVerifiedClosings, closingVerificationOf } from '../ghosts/task-close.js'
import { defaultGhostJournal } from '../ghosts/task-merged.js'
import { worktreeHome } from '../ghosts/worktree-home.js'
import { PR_OPENED } from './card-automaton.js'
import { CloseExecutor, failureOf, probeClosingCardIds } from './close-executor.js'
import { defaultBusPath } from './db.js'
import { EndedCardTrees, gitWorktrees, recordEndedTrees } from './ended-card-trees.js'
import { Node, prefixOf, runNode } from './node.js'
import { PR_CLOSED } from './observations.js'
import { closeCandidates } from './queue.js'
import { REDUCED } from './reducer.js'

export const PREFIX = prefixOf('close')
export const CLOSE_ON = [REDUCED, PR_CLOSED, PR_OPENED, CARD_VERIFIED] as const

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED])
const SCOPED_BY_PR_ON: ReadonlySet<string> = new Set([PR_CLOSED])

export type CloseStep = CloseOutcome

export interface CloseNodeParts {
  db: DatabaseSync
  reported: ReportedVerification
  clock: () => Date
  session: string
  journal: string
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
    this.executor = new CloseExecutor({ db: closeParts.db, reported: closeParts.reported, clock: closeParts.clock, journal: closeParts.journal, parking: closeParts.parking, trees: closeParts.trees })
    this.subscribe(CLOSE_ON, event => this.detectOn(event, scopeOf(event)))
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
    return `${step.taskKey}: closed, verification ${step.verification}; merge line ${step.cycle.mergeLine}, card file ${step.cycle.cardFile}${step.cycle.treeLeft === null ? '' : `; tree left at ${step.cycle.treeLeft.path}: ${step.cycle.treeLeft.left}`}`
  }
}

export function closingVerification(journal: string, busPath: string): ReportedVerification {
  return (cardId, pr) => pr === null ? null : closingVerificationOf(existsSync(journal) ? readFileSync(journal, 'utf8') : '', cardVerifiedClosings(busPath), String(cardId), pr)
}

export interface CloseRun {
  busPath: string
  reported: ReportedVerification
  session: string
  journal: string
  parking: string
  pause: (ms: number) => Promise<unknown>
  endedTrees?: (db: DatabaseSync) => () => EndedTree[]
}

export async function runCloseWorker(argv: string[], run: CloseRun): Promise<number> {
  return runNode(argv, 'close', run.busPath, (db, mode) => new CloseNode({ db, reported: run.reported, clock: () => new Date(), session: run.session, journal: run.journal, parking: run.parking, mode, env: process.env, endedTrees: run.endedTrees?.(db) }), { pause: run.pause })
}

async function main(): Promise<number> {
  const construct = path.join(os.homedir(), '.construct')
  const journal = defaultGhostJournal()
  const repo = process.cwd()
  const endedTrees = (db: DatabaseSync) => {
    const trees = new EndedCardTrees(db, [worktreeHome(process.env), path.dirname(repo)], gitWorktrees(repo), () => new Date())
    return () => trees.free()
  }
  const busPath = defaultBusPath()
  return runCloseWorker(process.argv.slice(2), { busPath, reported: closingVerification(journal, busPath), session: randomUUID(), journal, parking: path.join(construct, 'parking'), pause: sleep, endedTrees })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
