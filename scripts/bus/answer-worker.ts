import type { DatabaseSync } from 'node:sqlite'
import type { AnswerOutcome } from './answer-executor.js'
import type { Answerer } from './answerer.js'
import type { Lease } from './lease.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AnswerExecutor } from './answer-executor.js'
import { claudeAnswerer, PREFIX } from './answerer.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from './db.js'
import { messageOf, OWNER_MERGES } from './executor.js'
import { expireLeases, LEASE_FOLDS, RENEW_MS, renewLease, StaleLease, TASK_LEASED } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { LEASED, QUEUED } from './queue.js'
import { SWITCH_FLAG } from './review-worker.js'
import { slotsOf } from './scheduler.js'
import { storedByKey } from './stored.js'

const ANSWERS_DIR = path.join(os.homedir(), '.construct', 'bus', 'answers')

const NEXT_ON_A_FREE_CARD_TREE = `
  SELECT tasks.* FROM tasks LEFT JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'answer' AND tasks.state = '${QUEUED}' AND (tasks.pr IS NULL OR (prs.state = 'open' AND prs.head = tasks.head))
    AND NOT EXISTS (SELECT 1 FROM tasks AS held WHERE held.queue = 'answer' AND held.state = '${LEASED}' AND held.card_id = tasks.card_id)
  ORDER BY tasks.id LIMIT 1
`

interface AnswerRow {
  task_key: string
  card_id: number
  pr: number | null
  head: string | null
  lease_gen: number
}

export function leaseOnAFreeCardTree(db: DatabaseSync, ts: string, actor: string): Lease | null {
  return inTransaction(db, () => {
    const row = db.prepare(NEXT_ON_A_FREE_CARD_TREE).get() as AnswerRow | undefined
    if (row === undefined)
      return null
    const leaseGen = row.lease_gen + 1
    const dedupeKey = `${TASK_LEASED}:${row.task_key}:${leaseGen}`
    if (appendEvent(db, { ts, type: TASK_LEASED, actor, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey, payload: { task_key: row.task_key, queue: 'answer', lease_gen: leaseGen }, legacy: false }))
      LEASE_FOLDS[TASK_LEASED]!(db, storedByKey(db, dedupeKey))
    return { taskKey: row.task_key, queue: 'answer', cardId: row.card_id, pr: row.pr, head: row.head, leaseGen, actor }
  })
}

export type AnswerStep = { kind: 'idle' } | AnswerOutcome

export interface AnswerWorkerParts {
  db: DatabaseSync
  answerer: Answerer
  ownerMerges: () => string
  clock: () => Date
  session: string
}

export class AnswerWorker {
  readonly actor: string
  private readonly executor: AnswerExecutor

  constructor(private readonly parts: AnswerWorkerParts) {
    this.actor = `worker:answer:${parts.session}`
    this.executor = new AnswerExecutor(parts)
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  async step(): Promise<AnswerStep> {
    const { db } = this.parts
    expireLeases(db, this.ts())
    const lease = leaseOnAFreeCardTree(db, this.ts(), this.actor)
    if (lease === null)
      return { kind: 'idle' }
    const heartbeat = setInterval(() => {
      try {
        renewLease(db, this.ts(), lease)
      }
      catch (error) {
        if (error instanceof StaleLease)
          clearInterval(heartbeat)
        else
          console.error(`${PREFIX}${lease.taskKey}: the lease was not renewed this beat, the heartbeat keeps running: ${messageOf(error)}`)
      }
    }, RENEW_MS)
    try {
      return await this.executor.answer(lease)
    }
    finally {
      clearInterval(heartbeat)
    }
  }
}

export function startAnswerWorkers(parts: AnswerWorkerParts, slots: number): AnswerWorker[] {
  return Array.from({ length: slots }, (_, slot) => new AnswerWorker({ ...parts, session: `${parts.session}-${slot + 1}` }))
}

async function keepAnswering(worker: AnswerWorker, pause: (ms: number) => Promise<unknown>): Promise<never> {
  for (;;) {
    const step = await worker.step()
    const line = answerStepLine(step)
    if (line !== null)
      console.log(line)
    await pause(step.kind === 'idle' ? CHECK_MS : TICK_MS)
  }
}

export function answerStepLine(step: AnswerStep): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'answered')
    return `${PREFIX}${step.taskKey}: answered in ${step.resumed ? 'the card session' : 'a new session'} ${step.session}; the head is ${step.head}`
  if (step.kind === 'stopped')
    return `${PREFIX}${step.taskKey}: card.stopped (${step.reason}): ${step.detail}`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${step.denial.reason}): ${step.denial.detail}; the task is ${step.next}`
}

export interface AnswerRun {
  busPath: string
  answerer: Answerer
  ownerMerges: () => string
  session: string
  pause: (ms: number) => Promise<unknown>
}

export async function runAnswerWorker(argv: string[], run: AnswerRun): Promise<number> {
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG}`)
    return 0
  }
  const db = openBus(run.busPath)
  try {
    const workers = startAnswerWorkers({ db, answerer: run.answerer, ownerMerges: run.ownerMerges, clock: () => new Date(), session: run.session }, slotsOf('answer', process.env))
    for (const worker of workers)
      console.log(`${PREFIX}${run.busPath}: the answer worker ${worker.actor} takes the answer queue`)
    return await Promise.race(workers.map(worker => keepAnswering(worker, run.pause)))
  }
  finally {
    db.close()
  }
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  return runAnswerWorker(process.argv.slice(2), {
    busPath: defaultBusPath(),
    answerer: claudeAnswerer(ANSWERS_DIR),
    ownerMerges: () => readFileSync(path.join(cwd, OWNER_MERGES), 'utf8'),
    session: randomUUID(),
    pause: sleep,
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
