import type { DatabaseSync } from 'node:sqlite'
import type { CardTreeRemover, CloseOutcome, ReportedVerification } from './close-executor.js'
import type { EndedTree } from './ended-card-trees.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { closingVerificationOf } from '../ghosts/task-close.js'
import { defaultGhostJournal } from '../ghosts/task-merged.js'
import { worktreeHome } from '../ghosts/worktree-home.js'
import { reportPath } from '../shift/places.js'
import { CloseExecutor, failureOf } from './close-executor.js'
import { defaultBusPath, openBus } from './db.js'
import { EndedCardTrees, gitWorktrees, recordEndedTrees } from './ended-card-trees.js'
import { expireLeases, leaseNext } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { SWITCH_FLAG } from './review-worker.js'

export const PREFIX = '[bus:close] '
const REPORT_VERIFICATION_LINE = /^verification:\s*(\S+)\s*$/m

export type CloseStep = { kind: 'idle' } | CloseOutcome

export interface CloseWorkerParts {
  db: DatabaseSync
  reported: ReportedVerification
  clock: () => Date
  session: string
  journal: string
  parking: string
  trees?: CardTreeRemover
  endedTrees?: () => EndedTree[]
}

export class CloseWorker {
  readonly actor: string
  private readonly executor: CloseExecutor

  constructor(private readonly parts: CloseWorkerParts) {
    this.actor = `worker:close:${parts.session}`
    this.executor = new CloseExecutor(parts)
  }

  freeEndedTrees(): void {
    if (this.parts.endedTrees === undefined)
      return
    try {
      recordEndedTrees(this.parts.db, this.actor, this.parts.clock().toISOString(), this.parts.endedTrees())
    }
    catch (error) {
      console.error(`${PREFIX}the pass over ended cards' trees failed, the close goes on: ${failureOf(error)}`)
    }
  }

  step(): CloseStep {
    const ts = this.parts.clock().toISOString()
    expireLeases(this.parts.db, ts)
    const lease = leaseNext(this.parts.db, ts, 'close', this.actor)
    if (lease === null)
      return { kind: 'idle' }
    this.freeEndedTrees()
    const outcome = this.executor.close(lease)
    if (outcome.kind === 'closed' && outcome.cycle.treeLeft !== null)
      recordEndedTrees(this.parts.db, this.actor, this.parts.clock().toISOString(), [{ cardId: lease.cardId, ...outcome.cycle.treeLeft }])
    return outcome
  }
}

export function closeStepLine(step: CloseStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'closed')
    return `${PREFIX}${step.taskKey}: closed, verification ${step.verification}; merge line ${step.cycle.mergeLine}, card file ${step.cycle.cardFile}${step.cycle.treeLeft === null ? '' : `; tree left at ${step.cycle.treeLeft.path}: ${step.cycle.treeLeft.left}`}`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${step.denial.reason}): ${step.denial.detail}; the task is ${step.next}`
}

export function shiftReportVerification(shiftRoot: string): (cardId: number) => string | null {
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

export function journalVerification(journal: string): ReportedVerification {
  return (cardId, pr) => pr === null || !existsSync(journal) ? null : closingVerificationOf(readFileSync(journal, 'utf8'), String(cardId), pr)
}

export function anyExecutorVerification(shiftRoot: string, journal: string): ReportedVerification {
  const fromShift = shiftReportVerification(shiftRoot)
  const fromJournal = journalVerification(journal)
  return (cardId, pr) => fromShift(cardId) ?? fromJournal(cardId, pr)
}

export interface CloseRun {
  busPath: string
  reported: ReportedVerification
  session: string
  journal: string
  parking: string
  pause: (ms: number) => Promise<unknown>
  endedTrees?: (db: DatabaseSync) => () => EndedTree[]
}

export async function runCloseWorker(argv: string[], run: CloseRun): Promise<number> {
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG}`)
    return 0
  }
  const db = openBus(run.busPath)
  try {
    const worker = new CloseWorker({ db, reported: run.reported, clock: () => new Date(), session: run.session, journal: run.journal, parking: run.parking, endedTrees: run.endedTrees?.(db) })
    worker.freeEndedTrees()
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
  const construct = path.join(os.homedir(), '.construct')
  const journal = defaultGhostJournal()
  const repo = process.cwd()
  const endedTrees = (db: DatabaseSync) => {
    const trees = new EndedCardTrees(db, [worktreeHome(process.env), path.dirname(repo)], gitWorktrees(repo), () => new Date())
    return () => trees.free()
  }
  return runCloseWorker(process.argv.slice(2), { busPath: defaultBusPath(), reported: anyExecutorVerification(path.join(construct, 'shift'), journal), session: randomUUID(), journal, parking: path.join(construct, 'parking'), pause: sleep, endedTrees })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
