import type { DatabaseSync } from 'node:sqlite'
import type { AnswerOutcome } from './answer-executor.js'
import type { Answerer } from './answerer.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AnswerExecutor } from './answer-executor.js'
import { claudeAnswerer, PREFIX } from './answerer.js'
import { defaultBusPath, openBus } from './db.js'
import { messageOf, OWNER_MERGES } from './executor.js'
import { expireLeases, leaseNext, renewLease, StaleLease } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { RENEW_MS, SWITCH_FLAG } from './review-worker.js'

const ANSWERS_DIR = path.join(os.homedir(), '.construct', 'bus', 'answers')

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
    const lease = leaseNext(db, this.ts(), 'answer', this.actor)
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
    const worker = new AnswerWorker({ db, answerer: run.answerer, ownerMerges: run.ownerMerges, clock: () => new Date(), session: run.session })
    console.log(`${PREFIX}${run.busPath}: the answer worker ${worker.actor} takes the answer queue`)
    for (;;) {
      const step = await worker.step()
      const line = answerStepLine(step)
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
