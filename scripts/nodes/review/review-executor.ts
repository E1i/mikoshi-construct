import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import type { EventPayload } from '../../core/events.js'
import type { AfterFailure, Lease, SUPERSEDED_LEASE } from '../../core/lease.js'
import type { RoundReview } from '../../core/queue.js'
import type { LimitRule } from '../../policy/round-limit-decision.js'
import type { StatusPublisher } from '../../ports/github-status.js'
import type { GitHub } from '../../ports/github.js'
import type { Isolation, IsolationReader } from '../../ports/isolation.js'
import type { SessionInput } from '../../ports/prompt-store.js'
import type { RoundLimitAt, RoundLimitRecut } from './pr-close.js'
import type { Denial, VerdictWord } from './record-verdict.js'
import type { EarlierVerdict, ReviewDepth, ReviewPlan, ReviewPlanner } from './review-depth.js'
import type { HeldTree, LeftoverTree, Review, Reviewer } from './reviewer.js'
import { createHash } from 'node:crypto'
import { cardBodyText } from '../../core/card-bodies.js'
import { appendEvent } from '../../core/db.js'
import { ARTIFACT_REMOVED, BOARD_ALARM, POLICY_DENIED, REVIEW_RECORDED, REVIEW_ROUNDS_SPENT, REVIEW_TREE_ORPHANED, ROUND_EXTENDED } from '../../core/events.js'
import { reviewInputOfKey } from '../../core/identifiers.js'
import { completeTask, failTask, releaseTask, StaleLease, supersedeLease } from '../../core/lease.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { activeDecisionsShard, BODIES_OWNER_AMENDED_FOR_A_PR, changesRoundsOf, ownerAmendedSinceThePreviousReview, REPEAT_FINDINGS, REVIEW_ROUNDS, REVIEWS_OF_A_PR } from '../../core/queue.js'
import { allFindingsRepeat } from '../../policy/repeat-finding.js'
import { limitRuleOf } from '../../policy/round-limit-decision.js'
import { NO_ISOLATION } from '../../ports/isolation.js'
import { storedInput } from '../../ports/prompt-store.js'
import { freshDenial, recordVerdict } from './record-verdict.js'
import { cardRiskOf, fullReview } from './review-depth.js'
import { PREFIX, REVIEW_BAR_LINE, REVIEW_CEILING, REVIEW_CEILING_MINUTES, ReviewFailed } from './reviewer.js'

const CI_NOT_READY = 'ci_not_ready'
export const REVIEW_FAILED = 'review_failed'

export type ReviewDenial = Denial | { kind: 'technical', reason: typeof REVIEW_CEILING, detail: string }

export function windowRouteLine({ cardId, pr, head }: Pick<Lease, 'cardId' | 'pr' | 'head'>): string {
  return `The review of PR #${pr} (card #${cardId}) at head ${head} reached its ${REVIEW_CEILING_MINUTES}-minute ceiling with no verdict, and the bus starts no second session on it. The window takes it: ${pnpmCommand('bus:review', '--dry-run', String(pr))}, then, when that run is clean, ${pnpmCommand('bus:request', 'allow-merge', '--pr', String(pr), '--head', String(head), '--dry-run', '<reviewer session>')}.`
}

const STALE_HEAD = 'stale_head'
export const TREE_LEFT = 'tree_left'
export { REVIEW_ROUNDS_SPENT }
export const ROUND_LIMIT_REACHED = 'round_limit_reached'
export const SPAWNS_NO_SESSION = 'spawns-no-session'
export const REVIEW_RULES_VERSION = 1
export const REVIEW_RULES_FILE = '.claude/agents/review.md'
export const REVIEW_RULES_SHA = '5bc3df6ef4484cecce4ce4e3fe27143be831ee6b16a02340e94991d48014a009'

export function reviewRulesSha(rulesFileText: string): string {
  return createHash('sha256').update(`${rulesFileText}\n${REVIEW_BAR_LINE}`).digest('hex')
}
export const RULES_VERSION_KEY = 'rules_version'

export type Step
  = | { kind: 'idle' }
    | { kind: 'recorded', taskKey: string, verdict: VerdictWord, depth: ReviewDepth, model?: string }
    | { kind: 'denied', taskKey: string, denial: ReviewDenial, next: AfterFailure | typeof SUPERSEDED_LEASE }
    | { kind: 'fenced', taskKey: string }
    | { kind: 'waiting', taskKey: string, detail: string }

export interface ExecutorParts {
  db: DatabaseSync
  gitHub: GitHub
  publish: StatusPublisher
  reviewer: Reviewer
  plan: ReviewPlanner
  clock: () => Date
  silentMs: number
  prompts?: string
  clearLeftovers?: () => LeftoverTree[]
  notePr?: (pr: number, line: string) => void
  isolation: IsolationReader | typeof SPAWNS_NO_SESSION
  recut?: RoundLimitRecut
}

interface Reviewed {
  review: Review
  plan: ReviewPlan
  ms: number
  isolation: Held | null
  card: string | null
}

type Held = Exclude<Isolation, { level: 'none' }>

function isolationFields(isolation: Held | null): EventPayload<typeof REVIEW_RECORDED> {
  return isolation === null ? {} : { isolation: isolation.level, isolationGaps: isolation.gaps }
}

const RELEASE_REASONS: ReadonlySet<string> = new Set([NO_ISOLATION])

interface Attempt {
  outcome: Reviewed | ReviewDenial
  held: HeldTree | null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []
}

function ownVerdictKey(lease: Lease): string {
  return `${REVIEW_RECORDED}:${lease.taskKey}:`
}

export function earlierVerdict(db: DatabaseSync, lease: Lease): EarlierVerdict | null {
  if (lease.pr === null || lease.head === null)
    return null
  const row = db.prepare('SELECT payload FROM events WHERE type = ? AND pr = ? AND legacy = 0 AND substr(dedupe_key, 1, ?) != ? ORDER BY id DESC LIMIT 1').get(REVIEW_RECORDED, lease.pr, ownVerdictKey(lease).length, ownVerdictKey(lease)) as { payload: string } | undefined
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

export const AMEND_KEEPS_CHANGES = 'A pass cannot lift a changes verdict on the same head and pull request body: the amend of the card changed no code. Push a new head.'

function changesUnderTheSameBodies(db: DatabaseSync, lease: Lease): boolean {
  const input = reviewInputOfKey(lease.taskKey)
  if (input?.prBody === undefined || lease.pr === null || lease.head === null)
    return false
  const rows = db.prepare(`SELECT dedupe_key FROM events WHERE type = ? AND pr = ? AND head = ? AND legacy = 0 AND json_extract(payload, '$.verdict') = 'changes'`).all(REVIEW_RECORDED, lease.pr, lease.head) as { dedupe_key: string }[]
  return rows.some((row) => {
    const earlier = reviewInputOfKey(row.dedupe_key.split(':').slice(1, -1).join(':'))
    return earlier?.prBody === input.prBody && earlier.cardBody === input.cardBody
  })
}

function keptChanges(db: DatabaseSync, lease: Lease, review: Review): Review {
  return review.verdict === 'pass' && changesUnderTheSameBodies(db, lease)
    ? { ...review, verdict: 'changes', findings: [AMEND_KEEPS_CHANGES] }
    : review
}

function closedOnTheHead(db: DatabaseSync, lease: Lease): Set<string> {
  const rows = db.prepare(`SELECT json_extract(payload, '$.findings') AS findings FROM events WHERE type = ? AND pr = ? AND head = ? AND legacy = 0 ORDER BY id`).all(REVIEW_RECORDED, lease.pr, lease.head) as { findings: string | null }[]
  const rounds = rows.map(row => new Set(strings(row.findings === null ? [] : JSON.parse(row.findings))))
  return new Set(rounds.slice(0, -1).flatMap((listed, at) => [...listed].filter(finding => !rounds[at + 1]!.has(finding))))
}

function notReopened(db: DatabaseSync, lease: Lease, review: Review): Review {
  if (review.verdict !== 'changes' || lease.pr === null || lease.head === null)
    return review
  const closed = closedOnTheHead(db, lease)
  const findings = review.findings.filter(finding => !closed.has(finding))
  if (findings.length === review.findings.length)
    return review
  return findings.length === 0 ? { ...review, verdict: 'pass', findings } : { ...review, findings }
}

type CardRisk = ReturnType<typeof cardRiskOf>

const MUTATIONS_PASS_ON: readonly CardRisk[] = ['R3', 'R4']

export function passOnSurvivingMutations(review: Review, risk: CardRisk): Review {
  if (review.verdict !== 'changes' || review.findings.length === 0 || !MUTATIONS_PASS_ON.includes(risk))
    return review
  const marked = new Set((review.survivingMutations ?? []).map(finding => finding.trim()))
  return review.findings.every(finding => marked.has(finding.trim())) ? { ...review, verdict: 'pass' } : review
}

interface RoundLimit {
  rule: LimitRule
  event: BusEvent
}

const EXTENSION_OF_A_CARD = `SELECT 1 FROM events WHERE type = '${ROUND_EXTENDED}' AND legacy = 0 AND card_id = ? LIMIT 1`

const FINDINGS_OF_THE_EARLIER_ROUNDS = `SELECT json_extract(payload, '$.findings') AS findings FROM events WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? AND head IS NOT ? AND json_extract(payload, '$.verdict') = 'changes' ORDER BY id DESC`

function earlierRoundsFindings(db: DatabaseSync, lease: Lease): string[][] {
  const rows = db.prepare(FINDINGS_OF_THE_EARLIER_ROUNDS).all(lease.pr, lease.head) as { findings: string | null }[]
  return rows.map(row => row.findings === null ? [] : strings(JSON.parse(row.findings)))
}

export function roundLimitLine(pr: number, rounds: number): string {
  return `Review round limit reached (D-104): ${rounds} rounds of changes on PR #${pr}; the bus queues no further review or answer for it and does not merge it. The remaining findings are in the bus event ${REVIEW_ROUNDS_SPENT}.`
}

export function repeatStopLine(pr: number): string {
  return `Review stopped on a repeat: every finding of this round on PR #${pr} repeats an earlier round, so another answer would spend its tokens on what answers already did not close. The bus queues no further review or answer for it and does not merge it; it goes the way of the round limit (D-104), a re-cut or an owner decision. The findings are in the bus event ${REVIEW_ROUNDS_SPENT}.`
}

function treeFields({ tree }: Review): EventPayload<typeof REVIEW_RECORDED> {
  return tree === undefined ? {} : { tree_origin: tree.origin, treeBefore: tree.before, treeAfter: tree.after, treeMutated: tree.mutated }
}

function inputFields(prompts: string | undefined, plan: ReviewPlan, input: SessionInput | undefined): EventPayload<typeof REVIEW_RECORDED> {
  const stored = storedInput(prompts, input)
  return 'prompt_sha' in stored && plan.depth === 'diff' ? { ...stored, since: plan.since } : stored
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
    const isolation = this.parts.isolation === SPAWNS_NO_SESSION ? null : this.parts.isolation()
    if (isolation?.level === 'none')
      return this.denied(lease, { kind: 'technical', reason: NO_ISOLATION, detail: `PR #${lease.pr} is not reviewed: ${isolation.why}` })
    let held: HeldTree | null = null
    try {
      const attempt = await this.reviewed(lease, isolation)
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

  private async reviewed(lease: Lease, isolation: Held | null): Promise<Attempt> {
    const { db, clock } = this.parts
    const plan = planned(this.parts.plan, lease, earlierVerdict(db, lease))
    try {
      const started = clock().getTime()
      const card = cardBodyText(db, lease.cardId)
      const review = await this.parts.reviewer(lease, plan, card)
      return { outcome: { review, plan, ms: clock().getTime() - started, isolation, card }, held: review.tree ?? null }
    }
    catch (error) {
      const reason = error instanceof ReviewFailed && error.ceiling ? REVIEW_CEILING : REVIEW_FAILED
      return { outcome: { kind: 'technical', reason, detail: error instanceof Error ? error.message : String(error) }, held: error instanceof ReviewFailed ? error.held : null }
    }
  }

  private ceilingAlarm(lease: Lease, ts: string): BusEvent {
    return { ts, type: BOARD_ALARM, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${BOARD_ALARM}:${REVIEW_CEILING}:${lease.taskKey}`, payload: { reason: REVIEW_CEILING, task_key: lease.taskKey, detail: windowRouteLine(lease) }, legacy: false }
  }

  private released(lease: Lease, held: HeldTree): void {
    const left = held.release()
    if (left !== null)
      appendEvent(this.parts.db, orphaned(this.ts(), lease.actor, lease, held.path, left))
  }

  private settle(lease: Lease, reviewed: Reviewed | ReviewDenial): Step {
    const { db, gitHub, publish, clock } = this.parts
    if ('kind' in reviewed)
      return this.denied(lease, reviewed)
    const { plan } = reviewed
    const review = keptChanges(db, lease, passOnSurvivingMutations(notReopened(db, lease, reviewed.review), cardRiskOf(lease.cardId, reviewed.card)))
    const outcome = recordVerdict(db, gitHub, publish, { lease, verdict: review.verdict, reviewerSession: review.session }, () => clock().getTime())
    if (outcome.kind === 'denied')
      return this.denied(lease, outcome.denial)
    const repeats = this.repeatsAnEarlierRound(lease, review)
    const limit = this.roundLimit(lease, review, repeats)
    completeTask(db, this.ts(), lease, [this.recorded(lease, { ...reviewed, review }), ...(limit === null ? [] : [limit.event])])
    if (limit !== null && limit.rule.kind !== 'extend' && lease.pr !== null) {
      if (limit.rule.kind !== 'park')
        this.noted(lease.pr, repeats ? repeatStopLine(lease.pr) : roundLimitLine(lease.pr, REVIEW_ROUNDS))
      this.recutAtTheLimit({ cardId: lease.cardId, pr: lease.pr, head: lease.head, findings: review.findings, ...(limit.rule.kind === 'park' ? { mutations: limit.rule.mutations } : {}) })
    }
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: review.verdict, depth: plan.depth, model: review.model }
  }

  private repeatsAnEarlierRound(lease: Lease, review: Review): boolean {
    if (review.verdict !== 'changes' || lease.pr === null)
      return false
    return allFindingsRepeat(review.findings.filter(finding => finding !== AMEND_KEEPS_CHANGES), earlierRoundsFindings(this.parts.db, lease)) && !this.followsAnOwnerAmend(lease, review)
  }

  private followsAnOwnerAmend(lease: Lease, review: Review): boolean {
    const { db } = this.parts
    const reviews = db.prepare(REVIEWS_OF_A_PR).all(lease.pr) as unknown as RoundReview[]
    const amended = new Set((db.prepare(BODIES_OWNER_AMENDED_FOR_A_PR).all(lease.pr) as { body: string }[]).map(row => row.body))
    return ownerAmendedSinceThePreviousReview([...reviews, this.roundReview(lease, review)], reviews.length, amended)
  }

  private roundReview(lease: Lease, review: Review): RoundReview {
    return { head: lease.head, verdict: review.verdict, card_body: reviewInputOfKey(lease.taskKey)?.cardBody ?? null }
  }

  private roundLimit(lease: Lease, review: Review, repeats: boolean): RoundLimit | null {
    if (lease.pr === null)
      return null
    const before = changesRoundsOf(this.parts.db, lease.pr)
    const rounds = changesRoundsOf(this.parts.db, lease.pr, this.roundReview(lease, review))
    if (before >= REVIEW_ROUNDS || (rounds < REVIEW_ROUNDS && !repeats))
      return null
    const rule = this.limitRule(lease, review, repeats)
    if (rule.kind === 'extend')
      return { rule, event: this.extended(lease, rule) }
    return { rule, event: repeats ? this.spentOnARepeat(lease, review, rounds) : this.spent(lease, review, rounds) }
  }

  private limitRule(lease: Lease, review: Review, repeats: boolean): LimitRule {
    const { db, clock } = this.parts
    const rule = limitRuleOf({
      decisionsShard: activeDecisionsShard(db, clock()) !== null,
      findings: review.findings,
      survivingMutations: review.survivingMutations ?? [],
      previous: earlierRoundsFindings(db, lease)[0] ?? [],
      extendedBefore: db.prepare(EXTENSION_OF_A_CARD).get(lease.cardId) !== undefined,
    })
    return repeats && rule.kind === 'extend' ? { kind: 'owner' } : rule
  }

  private extended(lease: Lease, { findings, previous }: Extract<LimitRule, { kind: 'extend' }>): BusEvent {
    return {
      ts: this.ts(),
      type: ROUND_EXTENDED,
      actor: lease.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${ROUND_EXTENDED}:${lease.cardId}`,
      payload: { pr: lease.pr, findings, previous },
      legacy: false,
    }
  }

  private spent(lease: Lease, review: Review, rounds: number): BusEvent {
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

  private spentOnARepeat(lease: Lease, review: Review, rounds: number): BusEvent {
    const spent = this.spent(lease, review, rounds)
    return { ...spent, dedupeKey: `${spent.dedupeKey}:${REPEAT_FINDINGS}:${lease.head}`, payload: { state: REPEAT_FINDINGS, pr: lease.pr, rounds, findings: review.findings } }
  }

  private noted(pr: number, line: string): void {
    try {
      this.parts.notePr?.(pr, line)
    }
    catch (error) {
      console.error(`${PREFIX}PR #${pr}: the round-limit line was not added to its body, the bus event holds the report: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private recutAtTheLimit(at: RoundLimitAt): void {
    try {
      this.parts.recut?.recut(at)
    }
    catch (error) {
      console.error(`${PREFIX}PR #${at.pr}: the re-cut at the round limit stopped before its outcome was recorded, and the queue opens the owner wait for it: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private recorded(lease: Lease, { review, plan, ms, isolation }: Reviewed): BusEvent {
    return {
      ts: this.ts(),
      type: REVIEW_RECORDED,
      actor: lease.actor,
      cardId: lease.cardId,
      pr: lease.pr,
      head: lease.head,
      dedupeKey: `${REVIEW_RECORDED}:${lease.taskKey}:${lease.leaseGen}`,
      payload: { head: lease.head, card_body: reviewInputOfKey(lease.taskKey)?.cardBody ?? null, verdict: review.verdict, [RULES_VERSION_KEY]: REVIEW_RULES_VERSION, depth: plan.depth, depth_why: plan.why, review_ms: ms, reviewer_session: review.session, model: review.model, ...review.cache, findings: review.findings, ...treeFields(review), ...isolationFields(isolation), ...inputFields(this.parts.prompts, plan, review.input) },
      legacy: false,
    }
  }

  private waiting(lease: Lease, detail: string): Step {
    releaseTask(this.parts.db, this.ts(), lease, CI_NOT_READY)
    return { kind: 'waiting', taskKey: lease.taskKey, detail }
  }

  private denied(lease: Lease, denial: ReviewDenial): Step {
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
    if (RELEASE_REASONS.has(reason)) {
      releaseTask(this.parts.db, ts, lease, reason, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: 'queued' }
    }
    if (reason === STALE_HEAD)
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: supersedeLease(this.parts.db, ts, lease, [event]) }
    const atTheCeiling = reason === REVIEW_CEILING
    const next = failTask(this.parts.db, ts, lease, { reason, withdraw: denial.kind === 'authority' || atTheCeiling }, this.parts.silentMs, [event, ...(atTheCeiling ? [this.ceilingAlarm(lease, ts)] : [])])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}
