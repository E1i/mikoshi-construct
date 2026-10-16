import type { DatabaseSync } from 'node:sqlite'
import type { CardStarter, LaunchOutcome } from './launch-executor.js'
import type { Lease } from './lease.js'
import type { DetectionMode } from './node.js'
import type { QueuedTask } from './queue.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultParking } from '../ghosts/handoff-check.js'
import { MERGE_DONE, PR_OPENED } from './card-automaton.js'
import { defaultBusPath } from './db.js'
import { CARD_STARTED, CARD_STOPPED } from './inbox.js'
import { CARD_ADMITTED, CARD_CLOSED } from './launch-candidates.js'
import { LaunchExecutor } from './launch-executor.js'
import { realStarterPorts, ShiftCardStarter, treePrCommand } from './launch-starter.js'
import { TASK_COMPLETED, TASK_EXPIRED, TASK_FAILED, TASK_RELEASED } from './lease.js'
import { Node, prefixOf, runNode } from './node.js'
import { PR_CLOSED } from './observations.js'
import { PR_OBSERVED } from './operator-work.js'
import { launchTasks, TASK_ENQUEUED, TASK_REQUEUED, TASK_SUPERSEDED } from './queue.js'
import { REDUCED } from './reducer.js'

export const PREFIX = prefixOf('launch')
export const LAUNCH_DIR = 'launch'

const LEGACY_MERGE = 'merge'
const LEGACY_PATH = 'path'

export const LAUNCH_ON = [CARD_ADMITTED, CARD_STARTED, CARD_CLOSED, CARD_STOPPED, PR_CLOSED, PR_OBSERVED, PR_OPENED, LEGACY_MERGE, LEGACY_PATH, TASK_ENQUEUED, TASK_REQUEUED, TASK_COMPLETED, TASK_FAILED, TASK_SUPERSEDED, TASK_RELEASED, TASK_EXPIRED, MERGE_DONE, REDUCED] as const

export type LaunchStep = LaunchOutcome

export interface LaunchNodeParts {
  db: DatabaseSync
  starter: CardStarter
  clock: () => Date
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
}

export class LaunchNode extends Node<LaunchStep> {
  private readonly executor: LaunchExecutor

  constructor(launchParts: LaunchNodeParts) {
    super('launch', { db: launchParts.db, clock: launchParts.clock, session: launchParts.session, mode: launchParts.mode, env: launchParts.env })
    this.executor = new LaunchExecutor(launchParts)
    this.subscribe(LAUNCH_ON, event => this.detectOn(event))
  }

  protected candidates(): QueuedTask[] {
    return launchTasks(this.db)
  }

  protected override derivedCandidates(): QueuedTask[] {
    return launchTasks(this.db)
  }

  protected handle(lease: Lease): LaunchStep {
    return this.executor.launch(lease)
  }

  protected override stepLine(step: LaunchStep): string | null {
    if (step.kind === 'started')
      return `${step.taskKey}: started session ${step.card.session} as pid ${step.card.pid} (its own process group) in ${step.card.worktree} on ${step.card.branch} from ${step.card.base}`
    if (step.kind === 'fenced')
      return `${step.taskKey}: the lease moved on or the card is no longer queued; nothing written`
    return super.stepLine(step)
  }
}

export interface LaunchRun {
  busPath: string
  starter: CardStarter
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runLaunchWorker(argv: string[], run: LaunchRun): Promise<number> {
  return runNode(argv, 'launch', run.busPath, (db, mode) => new LaunchNode({ db, starter: run.starter, clock: () => new Date(), session: run.session, mode, env: process.env }), { pause: run.pause })
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const env = process.env
  const places = {
    parking: defaultParking(os.homedir()),
    launchDir: path.join(os.homedir(), '.construct', 'bus', LAUNCH_DIR),
    header: readFileSync(path.join(import.meta.dirname, '..', 'shift', 'header.md'), 'utf8'),
    claude: 'claude',
    treePr: treePrCommand(process.cwd()),
    env,
  }
  const starter = new ShiftCardStarter(places, realStarterPorts(process.cwd(), env, randomUUID))
  return runLaunchWorker(process.argv.slice(2), { busPath, starter, session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
