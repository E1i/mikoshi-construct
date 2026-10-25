import type { DatabaseSync } from 'node:sqlite'
import type { HolderStart } from '../../core/lease.js'
import type { ProcessTable } from './chain-process.js'
import type { DeadChain, RestartOutcome } from './restart-executor.js'
import type { RoleReturned, RoleToOwner } from './role.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultBusDir } from '../../core/bus-path.js'
import { defaultBusPath, openBus } from '../../core/db.js'
import { expireLeases, LEASE_MS, leaseNext, recordWorkerStarted } from '../../core/lease.js'
import { DATABASE_LOCKED, isDatabaseLocked } from '../../core/node.js'
import { CHECK_MS, TICK_MS } from '../../ports/netwatch.js'
import { ownStart } from '../../supervisor/heartbeat.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { switchedOn } from '../../supervisor/workers.js'
import { SWITCH_FLAG } from '../review/review-worker.js'
import { REAL_PROCESSES } from './chain-process.js'
import { relaunchKey, RestartExecutor } from './restart-executor.js'
import { returnSilentRole, roleToOwner } from './role.js'

export const PREFIX = '[bus:restart] '
export type RestartStep = { kind: 'idle' } | { kind: 'locked' } | { kind: 'dead_chains', chains: DeadChain[] } | ({ kind: 'returned' } & RoleReturned) | ({ kind: 'to_owner' } & RoleToOwner) | RestartOutcome

export interface RestartWorkerParts {
  db: DatabaseSync
  processes: ProcessTable
  launchSwitchedOn: () => boolean
  clock: () => Date
  session: string
  self?: HolderStart
}

export class RestartWorker {
  readonly actor: string
  private readonly executor: RestartExecutor
  private startRecorded = false

  constructor(private readonly parts: RestartWorkerParts) {
    this.actor = `worker:restart:${parts.session}`
    this.executor = new RestartExecutor(parts)
  }

  step(): RestartStep {
    try {
      return this.next()
    }
    catch (error) {
      if (!isDatabaseLocked(error))
        throw error
      return { kind: 'locked' }
    }
  }

  private next(): RestartStep {
    const ts = this.parts.clock().toISOString()
    if (!this.startRecorded) {
      recordWorkerStarted(this.parts.db, ts, this.actor, this.parts.self ?? ownStart())
      this.startRecorded = true
    }
    expireLeases(this.parts.db, ts)
    const lease = leaseNext(this.parts.db, ts, 'restart', this.actor)
    if (lease !== null)
      return this.executor.restart(lease)
    const chains = this.executor.deadChains(this.actor)
    if (chains.length > 0)
      return { kind: 'dead_chains', chains }
    const returned = returnSilentRole(this.parts.db, ts, this.actor)
    if (returned !== null)
      return { kind: 'returned', ...returned }
    const toOwner = roleToOwner(this.parts.db, ts, this.actor)
    return toOwner === null ? { kind: 'idle' } : { kind: 'to_owner', ...toOwner }
  }
}

export function restartStepLine(step: RestartStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'locked')
    return `${PREFIX}the step hit ${DATABASE_LOCKED}; it is retried in ${CHECK_MS / 1000} s, and the worker stays up`
  if (step.kind === 'dead_chains')
    return step.chains.map(chain => `${PREFIX}#${chain.cardId}: the chain in ${chain.dir} died with no restart task; observed ${chain.state}, nothing started`).join('\n')
  if (step.kind === 'returned')
    return `${PREFIX}${relaunchKey(step.role)}: back from the owner on ${step.handoff}: the owner's window went silent after ${step.lastSign}, ${LEASE_MS / 60_000} minutes without a sign, so its stop goes to the owner again`
  if (step.kind === 'to_owner')
    return `${PREFIX}${relaunchKey(step.role)}: to the owner${step.wait === null ? ' with no wait' : ` as owner wait ${step.wait}`}: ${step.detail}`
  if (step.kind === 'handed')
    return `${PREFIX}${step.taskKey}: the chain in ${step.dir} is stopped and retired; ${step.cardStopped ? `card #${step.cardId} is stopped as a fault and` : `card #${step.cardId} was not running and`} the launch node takes the lane`
  if (step.kind === 'waiting')
    return `${PREFIX}${step.taskKey}: the chain in ${step.dir} waits (${step.why}); nothing started`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.reason}): ${step.detail}; the task is ${step.next}`
}

export interface RestartRun {
  busPath: string
  processes: ProcessTable
  launchSwitchedOn: () => boolean
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runRestartWorker(argv: string[], run: RestartRun): Promise<number> {
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG}`)
    return 0
  }
  const db = openBus(run.busPath)
  try {
    const worker = new RestartWorker({ db, processes: run.processes, launchSwitchedOn: run.launchSwitchedOn, clock: () => new Date(), session: run.session })
    console.log(`${PREFIX}${run.busPath}: the restart worker ${worker.actor} takes the restart queue`)
    for (;;) {
      const step = worker.step()
      const line = restartStepLine(step)
      if (line !== null)
        console.log(line)
      await run.pause(step.kind === 'idle' || step.kind === 'locked' ? CHECK_MS : TICK_MS)
    }
  }
  finally {
    db.close()
  }
}

export function launchSwitchedOn(busDir: string): boolean {
  return switchedOn(busDir).includes('launch')
}

async function main(): Promise<number> {
  const busDir = defaultBusDir()
  return runRestartWorker(process.argv.slice(2), { busPath: defaultBusPath(), processes: REAL_PROCESSES, launchSwitchedOn: () => launchSwitchedOn(busDir), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
