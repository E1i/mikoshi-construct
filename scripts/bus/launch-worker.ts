import type { DatabaseSync } from 'node:sqlite'
import type { CardStarter, LaunchOutcome } from './launch-executor.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultParking } from '../ghosts/handoff-check.js'
import { defaultBusPath, openBus } from './db.js'
import { LaunchExecutor } from './launch-executor.js'
import { realStarterPorts, ShiftCardStarter } from './launch-starter.js'
import { expireLeases, leaseNext } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { SWITCH_FLAG } from './review-worker.js'

export const PREFIX = '[bus:launch] '
export const LAUNCH_DIR = 'launch'

export type LaunchStep = { kind: 'idle' } | LaunchOutcome

export interface LaunchWorkerParts {
  db: DatabaseSync
  starter: CardStarter
  clock: () => Date
  session: string
}

export class LaunchWorker {
  readonly actor: string
  private readonly executor: LaunchExecutor

  constructor(private readonly parts: LaunchWorkerParts) {
    this.actor = `worker:launch:${parts.session}`
    this.executor = new LaunchExecutor(parts)
  }

  step(): LaunchStep {
    const ts = this.parts.clock().toISOString()
    expireLeases(this.parts.db, ts)
    const lease = leaseNext(this.parts.db, ts, 'launch', this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.launch(lease)
  }
}

export function launchStepLine(step: LaunchStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'started')
    return `${PREFIX}${step.taskKey}: started session ${step.card.session} as pid ${step.card.pid} (its own process group) in ${step.card.worktree} on ${step.card.branch} from ${step.card.base}`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on or the card is no longer queued; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${step.denial.reason}): ${step.denial.detail}; the task is ${step.next}`
}

export interface LaunchRun {
  busPath: string
  starter: CardStarter
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runLaunchWorker(argv: string[], run: LaunchRun): Promise<number> {
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG}`)
    return 0
  }
  const db = openBus(run.busPath)
  try {
    const worker = new LaunchWorker({ db, starter: run.starter, clock: () => new Date(), session: run.session })
    console.log(`${PREFIX}${run.busPath}: the launch worker ${worker.actor} takes the launch queue`)
    for (;;) {
      const step = worker.step()
      const line = launchStepLine(step)
      if (line !== null)
        console.log(line)
      await run.pause(step.kind === 'idle' ? CHECK_MS : TICK_MS)
    }
  }
  finally {
    db.close()
  }
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const env = process.env
  const places = {
    parking: defaultParking(os.homedir()),
    launchDir: path.join(os.homedir(), '.construct', 'bus', LAUNCH_DIR),
    header: readFileSync(path.join(import.meta.dirname, '..', 'shift', 'header.md'), 'utf8'),
    claude: 'claude',
    env,
  }
  const starter = new ShiftCardStarter(places, realStarterPorts(process.cwd(), env, randomUUID))
  return runLaunchWorker(process.argv.slice(2), { busPath, starter, session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
