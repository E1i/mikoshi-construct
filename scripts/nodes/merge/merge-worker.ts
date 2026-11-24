import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { CatalogRebuilt } from '../../cli/check-catalog.js'
import type { Lease } from '../../core/lease.js'
import type { DetectionMode, NodeDeclaration, Scope } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { StoredEvent } from '../../core/stored.js'
import type { StatusPublisher } from '../../ports/github-status.js'
import type { GitHub, GitHubPut } from '../../ports/github.js'
import type { MainOverlap, MergeOutcome } from './merge-executor.js'
import type { DriftWatch } from './weights-drift.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { catalogIsEmpty, changedPaths, changesTheCatalog, MAIN_TIP, rebuildCatalogAt } from '../../cli/check-catalog.js'
import { appendEvent, defaultBusPath } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { EITHER_JOURNAL, events } from '../../core/events-query.js'
import { BOARD_ALARM, CARD_ADMITTED, DECISION_RECORDED, MERGE_DONE, PR_CLOSED, PR_GROUPS, PR_OBSERVED, PR_OPENED, REDUCED, REVIEW_RECORDED } from '../../core/events.js'
import { Node, NodeRefused, runNode, UNDERSTOOD_NOW } from '../../core/node.js'
import { pushPolicyOf } from '../../core/push-policy.js'
import { loadedCodeSha, readThroughPort } from '../../ports/git.js'
import { ghStatusPublisher } from '../../ports/github-status.js'
import { ghApi, ghApiPut } from '../../ports/github.js'
import { Meter } from '../../ports/meter.js'
import { busContract, candidateRules, mainOverlapAt, nodeLiveness, nodeSupply, requiredCheckAt, weightsDriftWatch } from '../../supervisor/composition.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { DRY_RUN_ACTOR } from '../review/review-worker.js'
import { mergeCandidates } from './merge-candidates.js'
import { MergeExecutor } from './merge-executor.js'
import { driftLine } from './weights-drift.js'

export const LIVE_REVIEWER = 'worker:review:'
export const CATALOG_REBUILD_FAILED = 'catalog_rebuild_failed'
export const MERGE_ON = [REDUCED, PR_OBSERVED, PR_CLOSED, PR_OPENED, PR_GROUPS, CARD_ADMITTED, MERGE_DONE, REVIEW_RECORDED, DECISION_RECORDED] as const

export const MERGE_NODE: NodeDeclaration = { kind: 'merge', on: MERGE_ON, understands: UNDERSTOOD_NOW }

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED, PR_GROUPS, MERGE_DONE, DECISION_RECORDED])

export type MergeStep = MergeOutcome

export type CatalogRebuild = (ref: string) => CatalogRebuilt | void

export interface MergeWorkerParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  session: string
  run: string | null
  pushPolicy?: () => PushPolicy
  rebuildCatalog?: CatalogRebuild
  overlaps?: MainOverlap
  weights?: DriftWatch
}

export interface MergeNodeParts extends MergeWorkerParts {
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  silentMs: number
}

export class NoLiveVerdict extends NodeRefused {
  constructor(worker = 'merge') {
    super(`no ${REVIEW_RECORDED} written by ${LIVE_REVIEWER}<session> yet; the ${worker} worker switches on after the review worker's first live verdict`)
  }
}

export function firstLiveVerdict(db: DatabaseSync): number | null {
  const [first] = events(db, { types: [REVIEW_RECORDED], actorPrefix: LIVE_REVIEWER, exceptActor: DRY_RUN_ACTOR, legacy: EITHER_JOURNAL, limit: 1 })
  return first === undefined ? null : first.id
}

function scopeOf(event: StoredEvent): Scope | undefined {
  if (WHOLE_QUEUE_ON.has(event.type))
    return undefined
  return { pr: event.pr ?? undefined, cardId: event.card_id ?? undefined }
}

export class MergeNode extends Node<MergeStep> {
  private readonly executor: MergeExecutor
  private readonly gitHub: GitHub
  private readonly rebuildCatalog: CatalogRebuild | undefined
  private readonly weights: DriftWatch | undefined

  constructor(parts: MergeNodeParts) {
    super('merge', { db: parts.db, clock: parts.clock, session: parts.session, mode: parts.mode, env: parts.env, silentMs: parts.silentMs, supply: nodeSupply() })
    this.gitHub = parts.gitHub
    this.rebuildCatalog = parts.rebuildCatalog
    this.weights = parts.weights
    this.executor = new MergeExecutor({ bus: busContract(), db: parts.db, cards: this.suppliedCards, gitHub: parts.gitHub, put: parts.put, publish: parts.publish, clock: parts.clock, run: parts.run, silentMs: parts.silentMs, pushPolicy: parts.pushPolicy, overlaps: parts.overlaps ?? mainOverlapAt(process.cwd()), rules: candidateRules(), requiredCheck: () => requiredCheckAt() })
    this.declare(MERGE_NODE, scopeOf)
  }

  protected override before(): void {
    if (firstLiveVerdict(this.db) === null)
      throw new NoLiveVerdict()
    this.log('the merge node merges the turn of each group, on a check before merge against actual main')
    if (catalogIsEmpty(this.db))
      this.rebuildAt(MAIN_TIP)
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return mergeCandidates(this.db, this.ts(), candidateRules()).filter(task => (scope.pr === undefined || task.pr === scope.pr) && (scope.cardId === undefined || task.cardId === scope.cardId))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return mergeCandidates(this.db, ts, candidateRules())
  }

  protected handle(lease: Lease): MergeStep {
    const step = this.executor.merge(lease)
    if (step.kind === 'merged') {
      this.refreshCatalog(step.commit, lease)
      this.watchWeights()
    }
    return step
  }

  private watchWeights(): void {
    if (this.weights === undefined)
      return
    try {
      this.log(driftLine(this.weights.watch()))
    }
    catch (error) {
      this.log(`test weights: nothing admitted: ${messageOf(error)}`)
    }
  }

  private refreshCatalog(commit: string, lease: Lease): void {
    if (this.rebuildCatalog === undefined)
      return
    try {
      const meter = new Meter(this.gitHub, () => this.parts.clock().getTime())
      if (catalogIsEmpty(this.db) || changesTheCatalog(changedPaths(meter, lease.pr!)))
        this.rebuildAt(commit)
    }
    catch (error) {
      this.catalogNotRebuilt(commit, error)
    }
  }

  private rebuildAt(ref: string): void {
    try {
      const rebuilt = this.rebuildCatalog?.(ref)
      if (rebuilt?.kind === 'skipped')
        this.log(`the check catalog is not rebuilt at ${ref}: ${rebuilt.reason}`)
    }
    catch (error) {
      this.catalogNotRebuilt(ref, error)
    }
  }

  private catalogNotRebuilt(ref: string, error: unknown): void {
    const ts = this.ts()
    appendEvent(this.db, { ts, type: BOARD_ALARM, actor: this.actor, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${CATALOG_REBUILD_FAILED}:${ref}:${ts}`, payload: { reason: CATALOG_REBUILD_FAILED, ref, detail: messageOf(error) }, legacy: false })
    this.log(`the check catalog stays as it was: the rebuild at ${ref} failed`)
  }

  protected override stepLine(step: MergeStep): string | null {
    if (step.kind === 'merged')
      return `${step.taskKey}: merged as ${step.commit} (${step.rule})`
    return super.stepLine(step)
  }
}

export interface MergeRun {
  busPath: string
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  session: string
  pushPolicy?: () => PushPolicy
  rebuildCatalog?: CatalogRebuild
  overlaps?: MainOverlap
  weights?: (db: DatabaseSync) => DriftWatch
  pause: (ms: number) => Promise<unknown>
}

export async function runMergeWorker(argv: string[], run: MergeRun): Promise<number> {
  return runNode(argv, 'merge', run.busPath, (db, mode) => new MergeNode({ ...nodeLiveness(), db, gitHub: run.gitHub, put: run.put, publish: run.publish, clock: () => new Date(), session: run.session, run: null, pushPolicy: run.pushPolicy, rebuildCatalog: run.rebuildCatalog, overlaps: run.overlaps, weights: run.weights?.(db), mode, env: process.env }), { pause: run.pause, codeSha: loadedCodeSha, supply: nodeSupply() })
}

export function liveMergeRun(cwd: string, busPath: string): MergeRun {
  const gitHub = ghApi(cwd)
  return { busPath, rebuildCatalog: ref => rebuildCatalogAt(ref, busPath, cwd), gitHub, put: ghApiPut(cwd), publish: ghStatusPublisher(cwd), session: randomUUID(), pause: sleep, pushPolicy: () => pushPolicyOf(readThroughPort, cwd), weights: weightsDriftWatch(gitHub, busPath) }
}

async function main(): Promise<number> {
  return runMergeWorker(process.argv.slice(2), liveMergeRun(process.cwd(), defaultBusPath()))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
