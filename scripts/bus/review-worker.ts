import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ghosts/verdict.js'
import type { BusEvent } from './db.js'
import type { GitHub } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import type { Denial, VerdictWord } from './record-verdict.js'
import type { Review, Reviewer } from './reviewer.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ghStatusPublisher } from '../ghosts/verdict.js'
import { defaultBusPath, openBus } from './db.js'
import { ghApi } from './github.js'
import { POLICY_DENIED } from './inbox.js'
import { completeTask, expireLeases, failTask, leaseNext, renewLease, StaleLease } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { recordVerdict } from './record-verdict.js'
import { shadowProblems } from './report.js'
import { claudeReviewer } from './reviewer.js'

export const PREFIX = '[bus:review] '
export const REVIEW_RECORDED = 'review.recorded'
export const RENEW_MS = 10 * 60_000
export const SWITCH_FLAG = '--on'

export type Step
  = | { kind: 'idle' }
    | { kind: 'recorded', taskKey: string, verdict: VerdictWord }
    | { kind: 'denied', taskKey: string, denial: Denial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface WorkerParts {
  db: DatabaseSync
  gitHub: GitHub
  publish: StatusPublisher
  reviewer: Reviewer
  clock: () => Date
  session: string
}

export class ShadowNotClean extends Error {
  constructor(readonly problems: string[]) {
    super(`the shadow report is not clean: ${problems.join('; ')}`)
  }
}

export class ReviewWorker {
  readonly actor: string

  constructor(private readonly parts: WorkerParts) {
    this.actor = `worker:review:${parts.session}`
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  async step(): Promise<Step> {
    const { db } = this.parts
    expireLeases(db, this.ts())
    const lease = leaseNext(db, this.ts(), 'review', this.actor)
    if (lease === null)
      return { kind: 'idle' }
    const heartbeat = setInterval(() => {
      try {
        renewLease(db, this.ts(), lease)
      }
      catch {
        clearInterval(heartbeat)
      }
    }, RENEW_MS)
    try {
      return this.settle(lease, await this.reviewed(lease))
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
    finally {
      clearInterval(heartbeat)
    }
  }

  private async reviewed(lease: Lease): Promise<Review | Denial> {
    try {
      return await this.parts.reviewer(lease)
    }
    catch (error) {
      return { kind: 'technical', reason: 'review_failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  private settle(lease: Lease, review: Review | Denial): Step {
    const { db, gitHub, publish, clock } = this.parts
    if ('kind' in review)
      return this.denied(lease, review)
    const outcome = recordVerdict(db, gitHub, publish, { lease, verdict: review.verdict, reviewerSession: review.session }, () => clock().getTime())
    if (outcome.kind === 'denied')
      return this.denied(lease, outcome.denial)
    completeTask(db, this.ts(), lease, [this.recorded(lease, review)])
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: review.verdict }
  }

  private recorded(lease: Lease, review: Review): BusEvent {
    return {
      ts: this.ts(),
      type: REVIEW_RECORDED,
      actor: this.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${REVIEW_RECORDED}:${lease.taskKey}:${lease.leaseGen}`,
      payload: { head: lease.head, verdict: review.verdict, reviewer_session: review.session, findings: review.findings },
      legacy: false,
    }
  }

  private denied(lease: Lease, denial: Denial): Step {
    const ts = this.ts()
    const reason = denial.kind === 'technical' ? denial.reason : denial.rule
    const event: BusEvent = {
      ts,
      type: POLICY_DENIED,
      actor: 'policy',
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`,
      payload: { command: 'record_verdict', ...denial },
      legacy: false,
    }
    const next = failTask(this.parts.db, ts, lease, { reason, withdraw: denial.kind === 'authority' }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

export function startReviewWorker(parts: WorkerParts): ReviewWorker {
  const problems = shadowProblems(parts.db, parts.gitHub, () => parts.clock().getTime())
  if (problems.length > 0)
    throw new ShadowNotClean(problems)
  return new ReviewWorker(parts)
}

export function stepLine(step: Step): string | null {
  if (step.kind === 'idle')
    return null
  if (step.kind === 'recorded')
    return `${PREFIX}${step.taskKey}: ${step.verdict} recorded`
  if (step.kind === 'fenced')
    return `${PREFIX}${step.taskKey}: the lease moved on; nothing written`
  const reason = step.denial.kind === 'technical' ? step.denial.reason : step.denial.rule
  return `${PREFIX}${step.taskKey}: denied (${step.denial.kind}, ${reason}): ${step.denial.detail}; the task is ${step.next}`
}

async function main(): Promise<number> {
  if (!process.argv.includes(SWITCH_FLAG)) {
    console.log(`${PREFIX}switched off; start it with ${SWITCH_FLAG} once pnpm bus:report is clean`)
    return 0
  }
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const cwd = process.cwd()
  const parts: WorkerParts = {
    db,
    gitHub: ghApi(cwd),
    publish: ghStatusPublisher(cwd),
    reviewer: claudeReviewer(cwd, path.join(os.homedir(), '.construct', 'bus', 'reviews')),
    clock: () => new Date(),
    session: randomUUID(),
  }
  try {
    const worker = startReviewWorker(parts)
    console.log(`${PREFIX}${busPath}: the review worker ${worker.actor} takes the review queue`)
    for (;;) {
      const step = await worker.step()
      const line = stepLine(step)
      if (line !== null)
        console.log(line)
      if (step.kind === 'idle')
        await sleep(CHECK_MS)
      else if (step.kind !== 'recorded')
        await sleep(TICK_MS)
    }
  }
  catch (error) {
    if (!(error instanceof ShadowNotClean))
      throw error
    console.error(`${PREFIX}refused to start, the shadow report is not clean:\n${error.problems.map(problem => `  ${problem}`).join('\n')}`)
    return 1
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
