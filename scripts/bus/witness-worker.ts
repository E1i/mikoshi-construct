import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from './lease.js'
import type { DetectionMode, Scope } from './node.js'
import type { QueuedTask } from './queue.js'
import type { StoredEvent } from './stored.js'
import type { TimedShell, WitnessOutcome, WitnessTrees } from './witness-executor.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CARD_ADMITTED, PR_OBSERVED, PR_OPENED, REDUCED } from '../core/events.js'
import { defaultBusPath } from './db.js'
import { Node, prefixOf, runNode } from './node.js'
import { witnessCandidates } from './queue.js'
import { stampLogOutput } from './stamp.js'
import { gitWitnessTrees, realTimedShell, WitnessExecutor } from './witness-executor.js'

export const PREFIX = prefixOf('witness')
export const WITNESS_ON = [REDUCED, PR_OBSERVED, PR_OPENED, CARD_ADMITTED] as const

const WHOLE_QUEUE_ON: ReadonlySet<string> = new Set([REDUCED])

export interface WitnessNodeParts {
  db: DatabaseSync
  clock: () => Date
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  trees: WitnessTrees
  shell: TimedShell
}

function scopeOf(event: StoredEvent): Scope | undefined {
  if (WHOLE_QUEUE_ON.has(event.type))
    return undefined
  return { pr: event.pr ?? undefined, cardId: event.card_id ?? undefined }
}

function inScope(task: QueuedTask, scope: Scope): boolean {
  return (scope.pr === undefined || task.pr === scope.pr) && (scope.cardId === undefined || task.cardId === scope.cardId)
}

export class WitnessNode extends Node<WitnessOutcome> {
  private readonly executor: WitnessExecutor

  constructor(parts: WitnessNodeParts) {
    super('witness', { db: parts.db, clock: parts.clock, session: parts.session, mode: parts.mode, env: parts.env })
    this.executor = new WitnessExecutor({ db: parts.db, clock: parts.clock, trees: parts.trees, shell: parts.shell, log: line => this.log(line) })
    this.subscribe(WITNESS_ON, scopeOf)
  }

  protected candidates(scope: Scope = {}): QueuedTask[] {
    return witnessCandidates(this.db, this.ts()).filter(task => inScope(task, scope))
  }

  protected override derivedCandidates(ts: string): QueuedTask[] {
    return witnessCandidates(this.db, ts)
  }

  protected handle(lease: Lease): WitnessOutcome {
    return this.executor.run(lease)
  }

  protected override stepLine(step: WitnessOutcome): string | null {
    if (step.kind === 'recorded')
      return `${step.taskKey}: witness ${step.verdict} on the base ${step.base}: ${step.detail}`
    if (step.kind === 'skipped')
      return `${step.taskKey}: no witness run: ${step.why}`
    return super.stepLine(step)
  }
}

export interface WitnessRun {
  busPath: string
  repo: string
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runWitnessWorker(argv: string[], run: WitnessRun): Promise<number> {
  return runNode(argv, 'witness', run.busPath, (db, mode) => new WitnessNode({ db, clock: () => new Date(), session: run.session, mode, env: process.env, trees: gitWitnessTrees(run.repo), shell: realTimedShell }), { pause: run.pause })
}

async function main(): Promise<number> {
  return runWitnessWorker(process.argv.slice(2), { busPath: defaultBusPath(), repo: process.cwd(), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
