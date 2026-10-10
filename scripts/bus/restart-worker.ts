import type { DatabaseSync } from 'node:sqlite'
import type { ChainLauncher, RelaunchOutcome, RestartOutcome, RoleLauncher } from './restart-executor.js'
import type { ProcessTable } from './chain-process.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runBg } from '../shift/bg.js'
import { CLAUDE_VARIABLE } from '../shift/claude.js'
import { runRelaunchBg } from '../shift/relaunch-bg.js'
import { REAL_PROCESSES, stopChain } from './chain-process.js'
import { defaultBusPath, openBus } from './db.js'
import { expireLeases, FAILURES_TO_STOP, leaseNext } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { relaunchKey, RestartExecutor } from './restart-executor.js'
import { SWITCH_FLAG } from './review-worker.js'
import { leaseRole, RAISED_VARIABLE, roleToOwner } from './role.js'

export const PREFIX = '[bus:restart] '
export const OPERATOR_CLAUDE = 'claude --permission-mode dontAsk'
export const MIKO_LAUNCH_OFF = 'the launch of pnpm miko is switched off: whether nohup pnpm miko can start a claude window without a terminal is not settled; start pnpm miko in a terminal'

export type RestartStep = { kind: 'idle' } | RestartOutcome | RelaunchOutcome

export interface RestartWorkerParts {
  db: DatabaseSync
  launcher: ChainLauncher
  roles: RoleLauncher
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
  if (step.kind === 'raised')
    return `${PREFIX}${relaunchKey(step.role)}: raised on ${step.handoff}, PID ${step.pid}`
  if (step.kind === 'raise_failed')
    return `${PREFIX}${relaunchKey(step.role)}: not raised on ${step.handoff}: ${step.detail}; the role is raised again until ${FAILURES_TO_STOP} raises in a row fail`
  if (step.kind === 'to_owner')
    return `${PREFIX}${relaunchKey(step.role)}: to the owner (question.owner): ${step.detail}`
  if (step.kind === 'restarted')
    return `${PREFIX}${step.taskKey}: the chain in ${step.fromDir} on ${step.from} restarted in ${step.dir} on ${step.to}, PID ${step.pid}`
  if (step.kind === 'waiting')
    return `${PREFIX}${step.taskKey}: the chain in ${step.dir} waits (${step.why}); nothing started`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.reason}): ${step.detail}; the task is ${step.next}`
}

export function checkoutLauncher(cwd: string, processes: ProcessTable = REAL_PROCESSES): ChainLauncher {
  return {
    holds: (sha) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd, stdio: 'ignore' })
        return true
      }
      catch {
        return false
      }
    },
    launch: (chain, dir) => {
      stopChain(chain, processes)
      const started = runBg([dir, '--parking', chain.parking, '--chain'])
      const pid = Number(started.stdout[0])
      if (started.exitCode !== 0 || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(started.stderr.join('; ') || `pnpm shift:bg ${dir} did not start`)
      return pid
    },
  }
}

function raiseOperator(handoff: string, env: NodeJS.ProcessEnv): number {
  const started = runRelaunchBg([handoff], { ...env, [CLAUDE_VARIABLE]: OPERATOR_CLAUDE, [RAISED_VARIABLE]: '1' })
  const pid = Number(started.stdout[0])
  if (started.exitCode !== 0 || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(started.stderr.join('; ') || `pnpm relaunch ${handoff} did not start`)
  return pid
}

export function roleLauncher(env: NodeJS.ProcessEnv = process.env): RoleLauncher {
  return {
    raise: (role, handoff) => {
      if (role === 'miko')
        throw new Error(MIKO_LAUNCH_OFF)
      return raiseOperator(handoff, env)
    },
  }
}

export interface RestartRun {
  busPath: string
  launcher: ChainLauncher
  roles: RoleLauncher
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
    const worker = new RestartWorker({ db, launcher: run.launcher, roles: run.roles, clock: () => new Date(), session: run.session })
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

async function main(): Promise<number> {
  return runRestartWorker(process.argv.slice(2), { busPath: defaultBusPath(), launcher: checkoutLauncher(process.cwd()), roles: roleLauncher(), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
