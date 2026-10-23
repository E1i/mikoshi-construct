import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ports/github-status.js'
import type { RerunMode } from './check-catalog.js'
import type { GitHub, GitHubPut } from './github.js'
import type { Lease } from './lease.js'
import type { DetectionMode, Scope } from './node.js'
import type { QueuedTask } from './queue.js'
import type { StoredEvent } from './stored.js'
import type { UpdateOutcome } from './update-executor.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, CARD_STOPPED, POLICY_DENIED, PR_OBSERVED, PR_OPENED, REDUCED } from '../core/events.js'
import { ghStatusPublisher } from '../ports/github-status.js'
import { rerunModeOf } from './check-catalog.js'
import { defaultBusPath } from './db.js'
import { ghApi, ghApiPut } from './github.js'
import { firstLiveVerdict, NoLiveVerdict } from './merge-worker.js'
import { Node, runNode } from './node.js'
import { updateCandidates } from './queue.js'
import { stampLogOutput } from './stamp.js'
import { UpdateExecutor } from './update-executor.js'

export const SETTLE_MS = 2000
export const UPDATE_ON = [REDUCED, PR_OBSERVED, PR_OPENED, CARD_ADMITTED, POLICY_DENIED, CARD_STOPPED] as const

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
    this.executor = new UpdateExecutor({ db: parts.db, gitHub: parts.gitHub, put: parts.put, publish: parts.publish, clock: parts.clock, settle: parts.settle, rerun: this.rerun })
    this.subscribe(UPDATE_ON, scopeOf)
  }

  protected override before(): void {
    if (firstLiveVerdict(this.db) === null)
      throw new NoLiveVerdict('update')
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
}

export async function runUpdateWorker(argv: string[], run: UpdateRun): Promise<number> {
  return runNode(argv, 'update', run.busPath, (db, mode) => new UpdateNode({ db, gitHub: run.gitHub, put: run.put, publish: run.publish, clock: () => new Date(), settle: run.settle, session: run.session, mode, env: process.env }), { pause: run.pause })
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  return runUpdateWorker(process.argv.slice(2), { busPath: defaultBusPath(), gitHub: ghApi(cwd), put: ghApiPut(cwd), publish: ghStatusPublisher(cwd), settle: () => blockFor(SETTLE_MS), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
