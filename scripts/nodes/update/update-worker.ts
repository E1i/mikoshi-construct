import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { RerunMode } from '../../cli/check-catalog.js'
import type { Lease } from '../../core/lease.js'
import type { DetectionMode, NodeDeclaration, Scope } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { StoredEvent } from '../../core/stored.js'
import type { StatusPublisher } from '../../ports/github-status.js'
import type { GitHub, GitHubPut } from '../../ports/github.js'
import type { MergeMain, UpdateOutcome } from './update-executor.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { rerunModeOf } from '../../cli/check-catalog.js'
import { defaultBusPath } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, POLICY_DENIED, PR_OBSERVED, PR_OPENED, REDUCED } from '../../core/events.js'
import { Node, runNode, UNDERSTOOD_NOW } from '../../core/node.js'
import { pushPolicyAt } from '../../core/push-policy.js'
import { updateCandidates } from '../../core/queue.js'
import { ghStatusPublisher } from '../../ports/github-status.js'
import { ghApi, ghApiPost, ghApiPut } from '../../ports/github.js'
import { cardTree } from '../../ports/worktree-home.js'
import { gitIn } from '../../ports/worktree.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { firstLiveVerdict, NoLiveVerdict } from '../merge/merge-worker.js'
import { mainMergeInCardTree, UpdateExecutor } from './update-executor.js'

export const SETTLE_MS = 2000
export const UPDATE_ON = [REDUCED, PR_OBSERVED, PR_OPENED, CARD_ADMITTED, POLICY_DENIED, CARD_STOPPED] as const

export const UPDATE_NODE: NodeDeclaration = { kind: 'update', on: UPDATE_ON, understands: UNDERSTOOD_NOW }

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED, CARD_ADMITTED])
const SCOPED_BY_PR_ON: ReadonlySet<string> = new Set([PR_OBSERVED])

export type UpdateStep = UpdateOutcome

export interface UpdateNodeParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  settle: () => void
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  pushPolicy?: () => PushPolicy
  mergeMain?: MergeMain
  post?: GitHubPut
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

export class UpdateNode extends Node<UpdateStep> {
  private readonly executor: UpdateExecutor
  private readonly rerun: RerunMode

  constructor(parts: UpdateNodeParts) {
    super('update', { db: parts.db, clock: parts.clock, session: parts.session, mode: parts.mode, env: parts.env })
    this.rerun = rerunModeOf(parts.env)
    this.executor = new UpdateExecutor({ db: parts.db, gitHub: parts.gitHub, put: parts.put, publish: parts.publish, clock: parts.clock, settle: parts.settle, rerun: this.rerun, pushPolicy: parts.pushPolicy, mergeMain: parts.mergeMain, post: parts.post })
    this.declare(UPDATE_NODE, scopeOf)
  }

  protected override before(): void {
    if (firstLiveVerdict(this.db) === null)
      throw new NoLiveVerdict('update')
    this.log(`the update node starts in rerun mode ${this.rerun}`)
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return updateCandidates(this.db, this.ts(), this.rerun).filter(task => inScope(task, scope))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return updateCandidates(this.db, ts, this.rerun)
  }

  protected handle(lease: Lease): UpdateStep {
    return this.executor.update(lease)
  }

  protected override stepLine(step: UpdateStep): string | null {
    if (step.kind === 'stopped')
      return `${step.taskKey}: stopped with ${step.reason}: ${step.detail}`
    if (step.kind === 'rerun')
      return `${step.taskKey}: ${step.requested ? 'a re-run requested' : 'no re-run'}: ${step.detail}`
    if (step.kind !== 'updated')
      return super.stepLine(step)
    const carry = step.carry.carried === null ? `no verdict carried: ${step.carry.why}` : `${step.carry.carried} carried`
    return `${step.taskKey}: updated ${step.from} to ${step.to ?? 'a head not seen yet'}; ${carry}`
  }
}

export function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface UpdateRun {
  busPath: string
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  settle: () => void
  session: string
  pause: (ms: number) => Promise<unknown>
  pushPolicy?: () => PushPolicy
  mergeMain?: MergeMain
  post?: GitHubPut
}

export async function runUpdateWorker(argv: string[], run: UpdateRun): Promise<number> {
  return runNode(argv, 'update', run.busPath, (db, mode) => new UpdateNode({ db, gitHub: run.gitHub, put: run.put, publish: run.publish, clock: () => new Date(), settle: run.settle, session: run.session, mode, env: process.env, pushPolicy: run.pushPolicy, mergeMain: run.mergeMain, post: run.post }), { pause: run.pause })
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  const busPath = defaultBusPath()
  const mergeMain = mainMergeInCardTree(gitIn, cardId => cardTree(process.env, busPath, String(cardId)))
  return runUpdateWorker(process.argv.slice(2), { busPath, mergeMain, gitHub: ghApi(cwd), put: ghApiPut(cwd), post: ghApiPost(cwd), publish: ghStatusPublisher(cwd), settle: () => blockFor(SETTLE_MS), session: randomUUID(), pause: sleep, pushPolicy: () => pushPolicyAt(cwd) })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
