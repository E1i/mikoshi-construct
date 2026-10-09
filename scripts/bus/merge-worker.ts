import type { DatabaseSync } from 'node:sqlite'
import type { MergeOutcome } from './executor.js'
import type { GitHub, GitHubPut } from './github.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from './db.js'
import { MergeExecutor } from './executor.js'
import { ghApi, ghApiPut } from './github.js'
import { expireLeases, leaseNext } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { DRY_RUN_ACTOR, REVIEW_RECORDED, SWITCH_FLAG } from './review-worker.js'

export const PREFIX = '[bus:merge] '
export const LIVE_REVIEWER = 'worker:review:'

export type MergeStep = { kind: 'idle' } | MergeOutcome

export interface MergeWorkerParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  clock: () => Date
  session: string
  run: string | null
}

export class NoLiveVerdict extends Error {
  constructor() {
    super(`no ${REVIEW_RECORDED} written by ${LIVE_REVIEWER}<session> yet; the merge worker switches on after the review worker's first live verdict`)
  }
}

export function firstLiveVerdict(db: DatabaseSync): number | null {
  const row = db.prepare(`SELECT id FROM events WHERE type = ? AND actor LIKE ? AND actor != ? ORDER BY id LIMIT 1`).get(REVIEW_RECORDED, `${LIVE_REVIEWER}%`, DRY_RUN_ACTOR) as { id: number } | undefined
  return row === undefined ? null : Number(row.id)
}

export class MergeWorker {
  readonly actor: string
  private readonly executor: MergeExecutor

  constructor(private readonly parts: MergeWorkerParts) {
    this.actor = `worker:merge:${parts.session}`
    this.executor = new MergeExecutor({ db: parts.db, gitHub: parts.gitHub, put: parts.put, clock: parts.clock, run: parts.run })
  }

  step(): MergeStep {
    const ts = this.parts.clock().toISOString()
    expireLeases(this.parts.db, ts)
    const lease = leaseNext(this.parts.db, ts, 'merge', this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.merge(lease)
  }
}

export function startMergeWorker(parts: MergeWorkerParts): MergeWorker {
  if (firstLiveVerdict(parts.db) === null)
    throw new NoLiveVerdict()
  return new MergeWorker(parts)
}

export function mergeStepLine(step: MergeStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'merged')
    return `${PREFIX}${step.taskKey}: merged as ${step.commit} (${step.rule})`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  const reason = step.denial.kind === 'technical' ? step.denial.reason : step.denial.rule
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${reason}): ${step.denial.detail}; the task is ${step.next}`
}

export interface MergeRun {
  busPath: string
  gitHub: GitHub
  put: GitHubPut
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runMergeWorker(argv: string[], run: MergeRun): Promise<number> {
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG} once the review worker has recorded a live verdict`)
    return 0
  }
  const db = openBus(run.busPath)
  try {
    const worker = startMergeWorker({ db, gitHub: run.gitHub, put: run.put, clock: () => new Date(), session: run.session, run: null })
    console.log(`${PREFIX}${run.busPath}: the merge worker ${worker.actor} takes the merge queue`)
    for (;;) {
      const step = worker.step()
      const line = mergeStepLine(step)
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
  return runMergeWorker(process.argv.slice(2), { busPath: defaultBusPath(), gitHub: ghApi(cwd), put: ghApiPut(cwd), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
