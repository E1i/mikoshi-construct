import type { DatabaseSync } from 'node:sqlite'
import type { StatusPublisher } from '../ghosts/verdict.js'
import type { BusEvent } from './db.js'
import type { GitHub } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import type { Denial, VerdictWord } from './record-verdict.js'
import type { EarlierVerdict, ReviewDepth, ReviewPlan, ReviewPlanner } from './review-depth.js'
import type { HeldTree, LeftoverTree, Review, Reviewer } from './reviewer.js'
import { REVIEW_RECORDED } from './card-automaton.js'
import { ARTIFACT_REMOVED } from './close-executor.js'
import { appendEvent } from './db.js'
import { POLICY_DENIED } from './inbox.js'
import { completeTask, failTask, releaseTask, StaleLease } from './lease.js'
import { BOARD_ALARM, changesRoundsOf, REVIEW_ROUNDS } from './queue.js'
import { freshDenial, recordVerdict } from './record-verdict.js'
import { fullReview } from './review-depth.js'
import { PREFIX, ReviewFailed } from './reviewer.js'

const CI_NOT_READY = 'ci_not_ready'
export const TREE_LEFT = 'tree_left'
export const REVIEW_ROUNDS_SPENT = 'review.rounds_spent'
export const ROUND_LIMIT_REACHED = 'round_limit_reached'
export const REVIEW_TREE_ORPHANED = 'review.tree.orphaned'

export type Step
  = | { kind: 'idle' }
    | { kind: 'recorded', taskKey: string, verdict: VerdictWord, depth: ReviewDepth, model?: string }
    | { kind: 'denied', taskKey: string, denial: Denial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }
    | { kind: 'waiting', taskKey: string, detail: string }

export interface ExecutorParts {
  db: DatabaseSync
  gitHub: GitHub
  publish: StatusPublisher
  reviewer: Reviewer
  plan: ReviewPlanner
  clock: () => Date
  clearLeftovers?: () => LeftoverTree[]
  notePr?: (pr: number, line: string) => void
}

interface Reviewed {
  review: Review
  plan: ReviewPlan
  ms: number
}

interface Attempt {
  outcome: Reviewed | Denial
  held: HeldTree | null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []
}

export function earlierVerdict(db: DatabaseSync, lease: Lease): EarlierVerdict | null {
  if (lease.pr === null || lease.head === null)
    return null
  const row = db.prepare('SELECT payload FROM events WHERE type = ? AND pr = ? AND head != ? AND legacy = 0 ORDER BY id DESC LIMIT 1').get(REVIEW_RECORDED, lease.pr, lease.head) as { payload: string } | undefined
  if (row === undefined)
    return null
  const payload = JSON.parse(row.payload) as { head?: unknown, verdict?: unknown, findings?: unknown }
  return typeof payload.head === 'string' && typeof payload.verdict === 'string'
    ? { head: payload.head, verdict: payload.verdict, findings: strings(payload.findings) }
    : null
}

export function planned(planner: ReviewPlanner, lease: Lease, earlier: EarlierVerdict | null): ReviewPlan {
  try {
    return planner(lease, earlier)
  }
  catch (error) {
    return fullReview(`the depth could not be planned: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function recordLeftovers(db: DatabaseSync, actor: string, ts: string, leftovers: LeftoverTree[]): void {
  for (const tree of leftovers) {
    const event: BusEvent = tree.left === null
      ? { ts, type: ARTIFACT_REMOVED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ARTIFACT_REMOVED}:review:${tree.path}`, payload: { path: tree.path, by: actor }, legacy: false }
      : { ts, type: BOARD_ALARM, actor, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${TREE_LEFT}:${tree.path}:${actor}`, payload: { reason: TREE_LEFT, path: tree.path, detail: tree.left }, legacy: false }
    appendEvent(db, event)
  }
}

export function roundLimitLine(pr: number, rounds: number): string {
  return `Review round limit reached (D-104): ${rounds} rounds of changes on PR #${pr}; the bus queues no further review or answer for it and does not merge it. The remaining findings are in the bus event ${REVIEW_ROUNDS_SPENT}.`
}

function treeFields({ tree }: Review): Record<string, unknown> {
  return tree === undefined ? {} : { treeBefore: tree.before, treeAfter: tree.after, treeMutated: tree.mutated }
}

function orphaned(ts: string, actor: string, lease: Lease, tree: string, detail: string): BusEvent {
  return { ts, type: REVIEW_TREE_ORPHANED, actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${REVIEW_TREE_ORPHANED}:${tree}`, payload: { path: tree, detail }, legacy: false }
}

export class ReviewExecutor {
  constructor(private readonly parts: ExecutorParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  async review(lease: Lease): Promise<Step> {
    if (this.parts.clearLeftovers !== undefined)
      recordLeftovers(this.parts.db, lease.actor, this.ts(), this.parts.clearLeftovers())
    const stale = freshDenial(this.parts.gitHub, lease, () => this.parts.clock().getTime())
    if (stale?.kind === 'technical' && stale.reason === CI_NOT_READY)
      return this.waiting(lease, stale.detail)
    if (stale !== null)
      return this.denied(lease, stale)
    let held: HeldTree | null = null
    try {
      const attempt = await this.reviewed(lease)
      held = attempt.held
      return this.settle(lease, attempt.outcome)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
    finally {
      if (held !== null)
        this.released(lease, held)
    }
  }

  private async reviewed(lease: Lease): Promise<Attempt> {
    const { db, clock } = this.parts
    const plan = planned(this.parts.plan, lease, earlierVerdict(db, lease))
    try {
      const started = clock().getTime()
      const review = await this.parts.reviewer(lease, plan)
      return { outcome: { review, plan, ms: clock().getTime() - started }, held: review.tree ?? null }
    }
    catch (error) {
      return { outcome: { kind: 'technical', reason: 'review_failed', detail: error instanceof Error ? error.message : String(error) }, held: error instanceof ReviewFailed ? error.held : null }
    }
  }

  private released(lease: Lease, held: HeldTree): void {
    const left = held.release()
    if (left !== null)
      appendEvent(this.parts.db, orphaned(this.ts(), lease.actor, lease, held.path, left))
  }

  private settle(lease: Lease, reviewed: Reviewed | Denial): Step {
    const { db, gitHub, publish, clock } = this.parts
    if ('kind' in reviewed)
      return this.denied(lease, reviewed)
    const { review, plan } = reviewed
    const outcome = recordVerdict(db, gitHub, publish, { lease, verdict: review.verdict, reviewerSession: review.session }, () => clock().getTime())
    if (outcome.kind === 'denied')
      return this.denied(lease, outcome.denial)
    const spent = this.roundsSpent(lease, review)
    completeTask(db, this.ts(), lease, [this.recorded(lease, reviewed), ...(spent === null ? [] : [spent])])
    if (spent !== null && lease.pr !== null)
      this.noted(lease.pr, roundLimitLine(lease.pr, REVIEW_ROUNDS))
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: review.verdict, depth: plan.depth, model: review.model }
  }

  private roundsSpent(lease: Lease, review: Review): BusEvent | null {
    if (review.verdict !== 'changes' || lease.pr === null)
      return null
    const rounds = changesRoundsOf(this.parts.db, lease.pr) + 1
    if (rounds < REVIEW_ROUNDS)
      return null
    return {
      ts: this.ts(),
      type: REVIEW_ROUNDS_SPENT,
      actor: lease.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${REVIEW_ROUNDS_SPENT}:${lease.pr}`,
      payload: { state: ROUND_LIMIT_REACHED, pr: lease.pr, rounds, findings: review.findings },
      legacy: false,
    }
  }

  private noted(pr: number, line: string): void {
    try {
      this.parts.notePr?.(pr, line)
    }
    catch (error) {
      console.error(`${PREFIX}PR #${pr}: the round-limit line was not added to its body, the bus event holds the report: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private recorded(lease: Lease, { review, plan, ms }: Reviewed): BusEvent {
    return {
      ts: this.ts(),
      type: REVIEW_RECORDED,
      actor: lease.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${REVIEW_RECORDED}:${lease.taskKey}:${lease.leaseGen}`,
      payload: { head: lease.head, verdict: review.verdict, depth: plan.depth, depth_why: plan.why, review_ms: ms, reviewer_session: review.session, model: review.model, ...review.cache, findings: review.findings, ...treeFields(review) },
      legacy: false,
    }
  }

  private waiting(lease: Lease, detail: string): Step {
    releaseTask(this.parts.db, this.ts(), lease, CI_NOT_READY)
    return { kind: 'waiting', taskKey: lease.taskKey, detail }
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
