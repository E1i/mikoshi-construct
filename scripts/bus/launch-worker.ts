import type { DatabaseSync } from 'node:sqlite'
import type { ProcessTable } from './chain-process.js'
import type { CardStarter, LaunchOutcome, StartedCard } from './launch-executor.js'
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
import { MERGE_DONE, PR_OPENED, RUNNING_CARD } from './card-automaton.js'
import { launchProcess, REAL_PROCESSES } from './chain-process.js'
import { appendEvent, defaultBusPath } from './db.js'
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

export const LAUNCH_LIMIT_MINUTES = 600

const LAUNCH_LIMIT_MS = LAUNCH_LIMIT_MINUTES * 60_000

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
  processes?: ProcessTable
}

interface RunningStart {
  card_id: number
  ts: string
  dedupe_key: string
  payload: string
}

const RUNNING_STARTS = `
  SELECT e.card_id, e.ts, e.dedupe_key, e.payload FROM cards AS c
  JOIN events AS e ON e.card_id = c.card_id AND e.type = '${CARD_STARTED}' AND e.legacy = 0
    AND e.id = (SELECT MAX(id) FROM events WHERE card_id = c.card_id AND type = '${CARD_STARTED}' AND legacy = 0)
  WHERE c.state = '${RUNNING_CARD}'
  ORDER BY c.card_id
`

function startedCardOf(payload: string): StartedCard | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const { session, worktree, branch, base, pid, pgid } = parsed
    if (typeof session !== 'string' || typeof worktree !== 'string' || typeof branch !== 'string' || typeof base !== 'string' || typeof pid !== 'number' || typeof pgid !== 'number')
      return null
    return { session, worktree, branch, base, pid, pgid }
  }
  catch {
    return null
  }
}

export class LaunchNode extends Node<LaunchStep> {
  private readonly executor: LaunchExecutor
  private readonly starter: CardStarter
  private readonly processes: ProcessTable

  constructor(launchParts: LaunchNodeParts) {
    super('launch', { db: launchParts.db, clock: launchParts.clock, session: launchParts.session, mode: launchParts.mode, env: launchParts.env })
    this.executor = new LaunchExecutor(launchParts)
    this.starter = launchParts.starter
    this.processes = launchParts.processes ?? REAL_PROCESSES
    this.subscribe(LAUNCH_ON, event => this.detectOn(event))
  }

  stopOverdue(): number[] {
    const stopped: number[] = []
    if (this.parts.mode !== 'live')
      return stopped
    for (const start of this.db.prepare(RUNNING_STARTS).all() as unknown as RunningStart[]) {
      const card = startedCardOf(start.payload)
      if (card === null || this.parts.clock().getTime() - Date.parse(start.ts) < LAUNCH_LIMIT_MS)
        continue
      if (launchProcess({ pgid: card.pgid, session: card.session }, this.processes) !== 'live')
        continue
      this.starter.stop(card)
      if (launchProcess({ pgid: card.pgid, session: card.session }, this.processes) !== 'gone')
        continue
      const detail = `time-limit: card #${start.card_id} ran past ${LAUNCH_LIMIT_MINUTES} minutes since ${start.ts}`
      const recorded = appendEvent(this.db, { ts: this.ts(), type: CARD_STOPPED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:time-limit:${start.dedupe_key}`, payload: { reason: 'fault', detail }, legacy: false })
      if (recorded)
        stopped.push(start.card_id)
    }
    return stopped
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
  let node: LaunchNode | undefined
  const build = (db: DatabaseSync, mode: DetectionMode): LaunchNode => {
    node = new LaunchNode({ db, starter: run.starter, clock: () => new Date(), session: run.session, mode, env: process.env })
    return node
  }
  const pause = async (ms: number): Promise<unknown> => {
    node?.stopOverdue()
    return run.pause(ms)
  }
  return runNode(argv, 'launch', run.busPath, build, { pause })
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
