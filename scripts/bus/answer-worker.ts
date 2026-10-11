import type { DatabaseSync } from 'node:sqlite'
import type { Priority } from '../../src/card/parking.js'
import type { AnswerOutcome } from './answer-executor.js'
import type { Answerer, CardText } from './answerer.js'
import type { CardTreeTools } from './card-tree.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { defaultParking } from '../ghosts/handoff-check.js'
import { AnswerExecutor } from './answer-executor.js'
import { claudeAnswerer, parkedCardText, PREFIX, realAnswererTools } from './answerer.js'
import { defaultBusPath, openBus } from './db.js'
import { messageOf, OWNER_MERGES } from './executor.js'
import { expireLeases, leaseNext, queuedCards, RENEW_MS, renewLease, StaleLease } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { SWITCH_FLAG } from './review-worker.js'
import { slotsOf } from './scheduler.js'

const ANSWERS_DIR = path.join(os.homedir(), '.construct', 'bus', 'answers')

export function priorityOf(cardText: CardText, cardId: number): Priority | null {
  const text = cardText(cardId)
  if (text === null)
    return null
  const parsed = parseParkingFile(`${cardId}.md`, text)
  return parsed.kind === 'parked' ? parsed.parked.priority : null
}

export type AnswerStep = { kind: 'idle' } | AnswerOutcome

export interface AnswerWorkerParts {
  db: DatabaseSync
  answerer: Answerer
  ownerMerges: () => string
  clock: () => Date
  session: string
  cardText: CardText
  trees?: CardTreeTools
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
    const firstCards = queuedCards(db, 'answer').filter(cardId => priorityOf(this.parts.cardText, cardId) === 'p0')
    const lease = leaseNext(db, this.ts(), 'answer', this.actor, { onePerCard: true, firstCards })
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

async function settledStep(worker: AnswerWorker): Promise<AnswerStep | { kind: 'faulted', detail: string }> {
  try {
    return await worker.step()
  }
  catch (error) {
    return { kind: 'faulted', detail: messageOf(error) }
  }
}

async function keepAnswering(worker: AnswerWorker, pause: (ms: number) => Promise<unknown>): Promise<never> {
  for (;;) {
    const step = await settledStep(worker)
    if (step.kind === 'faulted')
      console.error(`${PREFIX}${worker.actor}: the round threw, its lease lapses and is expired as a failure; this loop and its peers go on: ${step.detail}`)
    else if (step.kind !== 'idle')
      console.log(answerStepLine(step))
    await pause(step.kind === 'idle' ? CHECK_MS : TICK_MS)
  }
}

export function answerInSlots(workers: AnswerWorker[], pause: (ms: number) => Promise<unknown>): Promise<never> {
  return Promise.race(workers.map(worker => keepAnswering(worker, pause)))
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
  cardText: CardText
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
    const workers = startAnswerWorkers({ db, answerer: run.answerer, ownerMerges: run.ownerMerges, cardText: run.cardText, clock: () => new Date(), session: run.session }, slotsOf('answer', process.env))
    for (const worker of workers)
      console.log(`${PREFIX}${run.busPath}: the answer worker ${worker.actor} takes the answer queue`)
    return await answerInSlots(workers, run.pause)
  }
  finally {
    db.close()
  }
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  const parking = defaultParking(os.homedir())
  return runAnswerWorker(process.argv.slice(2), {
    busPath: defaultBusPath(),
    answerer: claudeAnswerer(ANSWERS_DIR, realAnswererTools(parking)),
    ownerMerges: () => readFileSync(path.join(cwd, OWNER_MERGES), 'utf8'),
    cardText: parkedCardText(parking),
    session: randomUUID(),
    pause: sleep,
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
