import type { DatabaseSync } from 'node:sqlite'
import type { ChainLauncher, RestartOutcome } from './restart-executor.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runBg } from '../shift/bg.js'
import { defaultBusPath, openBus } from './db.js'
import { expireLeases, leaseNext } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { RestartExecutor } from './restart-executor.js'
import { SWITCH_FLAG } from './review-worker.js'

export const PREFIX = '[bus:restart] '

export type RestartStep = { kind: 'idle' } | RestartOutcome

export interface RestartWorkerParts {
  db: DatabaseSync
  launcher: ChainLauncher
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
    return lease === null ? { kind: 'idle' } : this.executor.restart(lease)
  }
}

export function restartStepLine(step: RestartStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'restarted')
    return `${PREFIX}${step.taskKey}: the chain in ${step.fromDir} on ${step.from} restarted in ${step.dir} on ${step.to}, PID ${step.pid}`
  if (step.kind === 'waiting')
    return `${PREFIX}${step.taskKey}: the chain in ${step.dir} waits (${step.why}); nothing started`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.reason}): ${step.detail}; the task is ${step.next}`
}

function stopChain(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw error
  }
}

export function checkoutLauncher(cwd: string): ChainLauncher {
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
      stopChain(chain.pid)
      const started = runBg([dir, '--parking', chain.parking, '--chain'])
      const pid = Number(started.stdout[0])
      if (started.exitCode !== 0 || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(started.stderr.join('; ') || `pnpm shift:bg ${dir} did not start`)
      return pid
    },
  }
}

export interface RestartRun {
  busPath: string
  launcher: ChainLauncher
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
    const worker = new RestartWorker({ db, launcher: run.launcher, clock: () => new Date(), session: run.session })
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
  return runRestartWorker(process.argv.slice(2), { busPath: defaultBusPath(), launcher: checkoutLauncher(process.cwd()), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
