import type { DatabaseSync } from 'node:sqlite'
import type { ProcessTable } from './chain-process.js'
import type { DeadChain, RelaunchOutcome, RestartOutcome, RoleLauncher } from './restart-executor.js'
import type { RoleReturned } from './role.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { REAL_PROCESSES } from './chain-process.js'
import { defaultBusPath, openBus } from './db.js'
import { expireLeases, LEASE_MS, leaseNext } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { FAILURES_TO_STOP } from './queue.js'
import { relaunchKey, RestartExecutor } from './restart-executor.js'
import { SWITCH_FLAG } from './review-worker.js'
import { leaseRole, returnSilentRole, roleToOwner } from './role.js'
import { stampLogOutput } from './stamp.js'
import { switchedOn } from './workers.js'

export const PREFIX = '[bus:restart] '
export const MIKO_LAUNCH_OFF = 'the launch of pnpm miko is switched off: whether nohup pnpm miko can start a claude window without a terminal is not settled; start pnpm miko in a terminal'
export const OPERATOR_LAUNCH_GONE = 'the Operator has no launcher: its relaunch loop was removed with the shift runner, and the bus launch node starts the who: shift cards'

export type RestartStep = { kind: 'idle' } | { kind: 'dead_chains', chains: DeadChain[] } | ({ kind: 'returned' } & RoleReturned) | RestartOutcome | RelaunchOutcome

export interface RestartWorkerParts {
  db: DatabaseSync
  roles: RoleLauncher
  processes: ProcessTable
  launchSwitchedOn: () => boolean
  clock: () => Date
  session: string
}

export class RestartWorker {
  readonly actor: string
  private readonly executor: RestartExecutor

  constructor(private readonly parts: RestartWorkerParts) {
    this.actor = `worker:restart:${parts.session}`
    this.executor = new RestartExecutor(parts)
  }

  step(): RestartStep {
    const ts = this.parts.clock().toISOString()
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
    if (toOwner !== null)
      return { kind: 'to_owner', ...toOwner }
    const role = leaseRole(this.parts.db, ts, this.actor)
    return role === null ? { kind: 'idle' } : this.executor.relaunch(role)
  }
}

export function restartStepLine(step: RestartStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'dead_chains')
    return step.chains.map(chain => `${PREFIX}#${chain.cardId}: the chain in ${chain.dir} died with no restart task; observed ${chain.state}, nothing started`).join('\n')
  if (step.kind === 'raised')
    return `${PREFIX}${relaunchKey(step.role)}: raised on ${step.handoff}, PID ${step.pid}`
  if (step.kind === 'raise_failed')
    return `${PREFIX}${relaunchKey(step.role)}: not raised on ${step.handoff}: ${step.detail}; the role is raised again until ${FAILURES_TO_STOP} raises in a row fail`
  if (step.kind === 'returned')
    return `${PREFIX}${relaunchKey(step.role)}: back from the owner on ${step.handoff}: the owner's window went silent after ${step.lastSign}, ${LEASE_MS / 60_000} minutes without a sign, so the role is raisable again`
  if (step.kind === 'to_owner')
    return `${PREFIX}${relaunchKey(step.role)}: to the owner (question.owner): ${step.detail}`
  if (step.kind === 'handed')
    return `${PREFIX}${step.taskKey}: the chain in ${step.dir} is stopped and retired; ${step.cardStopped ? `card #${step.cardId} is stopped as a fault and` : `card #${step.cardId} was not running and`} the launch node takes the lane`
  if (step.kind === 'waiting')
    return `${PREFIX}${step.taskKey}: the chain in ${step.dir} waits (${step.why}); nothing started`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.reason}): ${step.detail}; the task is ${step.next}`
}

export function roleLauncher(): RoleLauncher {
  return {
    raise: (role) => {
      throw new Error(role === 'miko' ? MIKO_LAUNCH_OFF : OPERATOR_LAUNCH_GONE)
    },
  }
}

export interface RestartRun {
  busPath: string
  roles: RoleLauncher
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
    const worker = new RestartWorker({ db, roles: run.roles, processes: run.processes, launchSwitchedOn: run.launchSwitchedOn, clock: () => new Date(), session: run.session })
    console.log(`${PREFIX}${run.busPath}: the restart worker ${worker.actor} takes the restart queue`)
    for (;;) {
      const step = worker.step()
      const line = restartStepLine(step)
      if (line !== null)
        console.log(line)
      await run.pause(step.kind === 'idle' ? CHECK_MS : TICK_MS)
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
  const busDir = path.join(os.homedir(), '.construct', 'bus')
  return runRestartWorker(process.argv.slice(2), { busPath: defaultBusPath(), roles: roleLauncher(), processes: REAL_PROCESSES, launchSwitchedOn: () => launchSwitchedOn(busDir), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
