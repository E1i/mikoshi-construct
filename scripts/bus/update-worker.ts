import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ghosts/verdict.js'
import type { GitHub, GitHubPut } from './github.js'
import type { UpdateOutcome } from './update-executor.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ghStatusPublisher } from '../ghosts/verdict.js'
import { defaultBusPath, openBus } from './db.js'
import { ghApi, ghApiPut } from './github.js'
import { expireLeases, leaseNext } from './lease.js'
import { firstLiveVerdict, NoLiveVerdict } from './merge-worker.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { SWITCH_FLAG } from './review-worker.js'
import { UpdateExecutor } from './update-executor.js'

export const PREFIX = '[bus:update] '
export const SETTLE_MS = 2000

export type UpdateStep = { kind: 'idle' } | UpdateOutcome

export interface UpdateWorkerParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  settle: () => void
  session: string
}

export class UpdateWorker {
  readonly actor: string
  private readonly executor: UpdateExecutor

  constructor(private readonly parts: UpdateWorkerParts) {
    this.actor = `worker:update:${parts.session}`
    this.executor = new UpdateExecutor(parts)
  }

  step(): UpdateStep {
    const ts = this.parts.clock().toISOString()
    expireLeases(this.parts.db, ts)
    const lease = leaseNext(this.parts.db, ts, 'update', this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.update(lease)
  }
}

export function startUpdateWorker(parts: UpdateWorkerParts): UpdateWorker {
  if (firstLiveVerdict(parts.db) === null)
    throw new NoLiveVerdict('update')
  return new UpdateWorker(parts)
}

export function updateStepLine(step: UpdateStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'updated') {
    const carry = step.carry.carried === null ? `no verdict carried: ${step.carry.why}` : `${step.carry.carried} carried`
    return `${PREFIX}${step.taskKey}: updated ${step.from} to ${step.to ?? 'a head not seen yet'}; ${carry}`
  }
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${step.denial.reason}): ${step.denial.detail}; the task is ${step.next}`
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
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG} once the review worker has recorded a live verdict`)
    return 0
  }
  const db = openBus(run.busPath)
  try {
    const worker = startUpdateWorker({ db, gitHub: run.gitHub, put: run.put, publish: run.publish, clock: () => new Date(), settle: run.settle, session: run.session })
    console.log(`${PREFIX}${run.busPath}: the update worker ${worker.actor} takes the update queue`)
    for (;;) {
      const step = worker.step()
      const line = updateStepLine(step)
      if (line !== null)
        console.log(line)
      await run.pause(step.kind === 'idle' ? CHECK_MS : TICK_MS)
    }
  }
  catch (error) {
    if (!(error instanceof NoLiveVerdict))
      throw error
    console.error(`${PREFIX}refused to switch on: ${error.message}`)
    return 1
  }
  finally {
    db.close()
  }
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  return runUpdateWorker(process.argv.slice(2), { busPath: defaultBusPath(), gitHub: ghApi(cwd), put: ghApiPut(cwd), publish: ghStatusPublisher(cwd), settle: () => blockFor(SETTLE_MS), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
