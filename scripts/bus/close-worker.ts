import type { DatabaseSync } from 'node:sqlite'
import type { CloseOutcome, ReportedVerification } from './close-executor.js'
import type { GitHubPut } from './github.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { reportPath } from '../shift/places.js'
import { CloseExecutor } from './close-executor.js'
import { defaultBusPath, openBus } from './db.js'
import { ghApiPatch } from './github.js'
import { expireLeases, leaseNext } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { SWITCH_FLAG } from './review-worker.js'

export const PREFIX = '[bus:close] '
const REPORT_VERIFICATION_LINE = /^verification:\s*(\S+)\s*$/m

export type CloseStep = { kind: 'idle' } | CloseOutcome

export interface CloseWorkerParts {
  db: DatabaseSync
  patch: GitHubPut
  reported: ReportedVerification
  clock: () => Date
  session: string
}

export class CloseWorker {
  readonly actor: string
  private readonly executor: CloseExecutor

  constructor(private readonly parts: CloseWorkerParts) {
    this.actor = `worker:close:${parts.session}`
    this.executor = new CloseExecutor(parts)
  }

  step(): CloseStep {
    const ts = this.parts.clock().toISOString()
    expireLeases(this.parts.db, ts)
    const lease = leaseNext(this.parts.db, ts, 'close', this.actor)
    return lease === null ? { kind: 'idle' } : this.executor.close(lease)
  }
}

export function closeStepLine(step: CloseStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'closed')
    return `${PREFIX}${step.taskKey}: closed, verification ${step.verification}`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${step.denial.reason}): ${step.denial.detail}; the task is ${step.next}`
}

export function shiftReportVerification(shiftRoot: string): ReportedVerification {
  return (cardId) => {
    if (!existsSync(shiftRoot))
      return null
    const reports = readdirSync(shiftRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => reportPath(path.join(shiftRoot, entry.name), String(cardId)))
      .filter(file => existsSync(file))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    const newest = reports[0]
    return newest === undefined ? null : REPORT_VERIFICATION_LINE.exec(readFileSync(newest, 'utf8'))?.[1] ?? null
  }
}

export interface CloseRun {
  busPath: string
  patch: GitHubPut
  reported: ReportedVerification
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runCloseWorker(argv: string[], run: CloseRun): Promise<number> {
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG}`)
    return 0
  }
  const db = openBus(run.busPath)
  try {
    const worker = new CloseWorker({ db, patch: run.patch, reported: run.reported, clock: () => new Date(), session: run.session })
    console.log(`${PREFIX}${run.busPath}: the close worker ${worker.actor} takes the close queue`)
    for (;;) {
      const step = worker.step()
      const line = closeStepLine(step)
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
  return runCloseWorker(process.argv.slice(2), { busPath: defaultBusPath(), patch: ghApiPatch(process.cwd()), reported: shiftReportVerification(path.join(os.homedir(), '.construct', 'shift')), session: randomUUID(), pause: sleep })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
