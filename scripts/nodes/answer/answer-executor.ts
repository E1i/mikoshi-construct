import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, Lease } from '../../core/lease.js'
import type { WaitStep } from '../../core/node.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { Isolation, IsolationReader } from '../../ports/isolation.js'
import type { TreePreparer } from '../../ports/prepare-tree.js'
import type { AnswerInput } from '../../ports/prompt-store.js'
import type { AdmittedScope, AnswerSource, CardSession } from './answer-source.js'
import type { Answered, Answerer, StepSeconds, TreeMerge } from './answerer.js'
import type { CardConcept } from './concept-scope.js'
import { pathsIn, pathsOutside } from '../../../src/card/covering-tests.js'
import { riskOf } from '../../../src/card/risk.js'
import { CLOSED_WAIT, OWNER_WAITS } from '../../core/bus-readings.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { ANSWER_STEP, CARD_ANSWERED, CARD_STOPPED, POLICY_DENIED, PR_OBSERVED, PR_OPENED, QUESTION_AGENT, QUESTION_OWNER, SCOPE_WIDENED, SHARD_DECIDED, WITNESS_RECORDED } from '../../core/events.js'
import { assertHeld, completeTask, failTask, StaleLease, supersedeLease, waitTask } from '../../core/lease.js'
import { answerOnAnOldCardBody, DOWNGRADE_WAIT_OPEN, downgradeWaitOpenOn, FAILURES_TO_STOP, REVIEW_ROUNDS, supersededAnswerWithinItsLease } from '../../core/queue.js'
import { OWNER_EVEN_UNDER_THE_DECISION, reservationOf } from '../../policy/policy.js'
import { activeDecisionsShard, activeWindowShards, cardDecisionCommand, DECISIONS_SCOPE, decisionsInForceAt, ownersUnderAnyShard, unspentShard } from '../../policy/shards.js'
import { matchGlob } from '../../policy/shredder/glob.js'
import { ownerGlobs } from '../../policy/widening.js'
import { cardTreeOf, CardTreeRefused, realCardTrees } from '../../ports/card-tree.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { prepareBeforeSession, prepareTree } from '../../ports/prepare-tree.js'
import { sha256, storedInput } from '../../ports/prompt-store.js'
import { MAIN_BRANCH } from '../../ports/snapshot.js'
import { admittedScopeOf, answerSourceOf, boundDecisionLines, decisionAnsweringRepeat, ownerHoldOf } from './answer-source.js'
import { AnswerOutsideTouches, CardTreeGone, liveSessionIn, PREFIX, secondsOf, treeDirtyOf, treeMergeOf } from './answerer.js'
import { CONCEPT_WIDENING_REASON } from './concept-scope.js'

export type AnswerTechnicalReason = 'nothing_to_answer' | 'no_card_tree' | 'card_tree_gone' | 'answer_failed' | 'left_nothing' | 'held_for_owner' | 'outside_touches' | 'repeated_stop' | 'old_card_body' | 'closed_wait' | typeof DOWNGRADE_WAIT_OPEN

export interface AnswerDenial {
  kind: 'technical'
  reason: AnswerTechnicalReason
  detail: string
}

export type AnswerOutcome
  = | { kind: 'answered', taskKey: string, session: string, resumed: boolean, head: string }
    | { kind: 'published', taskKey: string, session: string, pr: number }
    | { kind: 'stopped', taskKey: string, reason: string, detail: string }
    | { kind: 'decided', taskKey: string, shard: string, question: string }
    | { kind: 'denied', taskKey: string, denial: AnswerDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }
    | { kind: 'waiting', taskKey: string, wait: string, detail: string }
    | WaitStep

export interface TreePublishing {
  committed: (card: CardSession) => boolean
  publish: (card: CardSession, cardId: number) => void
}

export interface ShardDecision {
  answer: string
  doneBy?: string
}

export type ShardDecider = (lease: Lease, question: string) => ShardDecision | null

export interface AnswerParts {
  db: DatabaseSync
  answerer: Answerer
  ownerMerges: () => string
  clock: () => Date
  shardDecider?: ShardDecider
  trees?: CardTreeTools
  treeMerge?: (card: CardSession) => TreeMerge
  isolation?: IsolationReader
  prompts?: string
  dirty?: (card: CardSession) => boolean
  liveSession?: (card: CardSession) => string | null
  prepare?: TreePreparer
  publishing?: TreePublishing
}

type Answering = AnswerSource & { reentry?: true }

interface Widened {
  event: BusEvent
  reason: string
  paths: string[]
}

const DECISION_OPTIONS = [`${QUESTION_OWNER}: stop the card for the owner`, `${SHARD_DECIDED}: the window decides and the card goes on`]

const ASKS_ABOUT_THE_SCOPE = /\b(?:touches|creates|scope)\b/i

const NAMES_A_WAIT = /\b[QW]\d+\b/g

const IS_A_CLOSED_WAIT = `SELECT 1 FROM ${OWNER_WAITS} WHERE id = ? AND state = '${CLOSED_WAIT}'`

const CLOSED_WAITS_OF_THE_CARD = `SELECT id, answer FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${CLOSED_WAIT}' ORDER BY event_id`

const SUPERSEDED_SESSION_ENDING = 'superseded_session_ending'

function ownersEvenUnderTheDecision(paths: readonly string[]): string | undefined {
  return paths.find(file => riskOf(file).level === OWNER_EVEN_UNDER_THE_DECISION)
}

const DIRTY_ON_HEAD = `SELECT 1 FROM prs WHERE pr = ? AND head = ? AND state = 'open' AND mergeable = 'dirty'`

const FAILURES_IN_A_ROW = 'SELECT failures FROM tasks WHERE task_key = ?'

const LEFT_NOTHING = 'left_nothing'

const A_PR_OF_THE_CARD = `
  SELECT pr FROM prs WHERE card_id = :card
  UNION ALL SELECT pr FROM events WHERE card_id = :card AND pr IS NOT NULL AND type IN ('${PR_OPENED}', '${PR_OBSERVED}')
  LIMIT 1
`

const DENIALS_OF_THE_TASK = `type = '${POLICY_DENIED}' AND substr(dedupe_key, 1, length(:prefix)) = :prefix`

const EMPTY_ANSWERS_IN_A_ROW = `
  SELECT count(*) AS n FROM events
  WHERE ${DENIALS_OF_THE_TASK} AND json_extract(payload, '$.reason') = '${LEFT_NOTHING}'
    AND id > coalesce((SELECT max(id) FROM events WHERE ${DENIALS_OF_THE_TASK} AND json_extract(payload, '$.reason') != '${LEFT_NOTHING}'), 0)
`

const RED_WITNESS_ON_HEAD = `
  SELECT json_extract(red.payload, '$.detail') AS detail FROM events AS red
  WHERE red.id = (SELECT max(latest.id) FROM events AS latest WHERE latest.type = '${WITNESS_RECORDED}' AND latest.legacy = 0 AND latest.pr = ? AND latest.head = ?)
    AND json_extract(red.payload, '$.verdict') = 'red'
`

const REENTRY_SOURCES: ReadonlySet<AnswerSource['kind']> = new Set(['ci'])

const WITHDRAWN_REASONS: ReadonlySet<AnswerTechnicalReason> = new Set(['nothing_to_answer', 'card_tree_gone', 'held_for_owner', DOWNGRADE_WAIT_OPEN])

export const ANSWER_RESTARTS = 3

const MS_PER_MINUTE = 60_000

function minutesSince(start: number, end: number): number {
  return Math.round((end - start) / MS_PER_MINUTE * 10) / 10
}

function cardBodyOf(input: AnswerInput | undefined): { card_body_sha: string } | Record<string, never> {
  return input === undefined || input.cardBody === null ? {} : { card_body_sha: sha256(input.cardBody) }
}

function measurementOf(answered: Answered, minutes: number): { minutes: number, tokens: number | null } | Record<string, never> {
  return answered.tokens === undefined ? {} : { minutes, tokens: answered.tokens }
}

function stepsOf(answered: Answered): { steps: StepSeconds } | Record<string, never> {
  return answered.steps === undefined ? {} : { steps: answered.steps }
}

function leftNoNewHead(answered: Answered): boolean {
  return answered.after === null || answered.after === answered.before
}

function endedOnContextWarn(answered: Answered | AnswerDenial): boolean {
  return !('kind' in answered) && answered.atContextWarn === true && answered.owner === null && leftNoNewHead(answered)
}

export function scopeWideningAsked(question: string, scope: AdmittedScope | null, underAShard: boolean): string[] {
  return !underAShard || scope === null || !ASKS_ABOUT_THE_SCOPE.test(question) ? [] : pathsOutside(scope.touches, scope.creates, pathsIn(question))
}

function decisionSource(question: string, ground: string, decision: ShardDecision, decisions: string[]): AnswerSource {
  const whoActs = decision.doneBy === undefined ? '' : ` ${decision.doneBy} does it, not this session.`
  return { kind: 'question', detail: `your question went to the window, and the window decided it under ${ground}: ${decision.answer}.${whoActs} The card goes on without the owner. The question was: ${question}`, widen: null, events: [], decisions }
}

function heldForTheWindow(question: string, shard: string, why: string): string {
  return `${question} (held for the window under the ${DECISIONS_SCOPE} shard ${shard}: ${why}; the window closes the wait with its answer)`
}

function reasonOfFailure(error: unknown): AnswerTechnicalReason {
  if (error instanceof CardTreeGone)
    return 'card_tree_gone'
  return error instanceof AnswerOutsideTouches ? 'outside_touches' : 'answer_failed'
}

export class AnswerExecutor {
  constructor(private readonly parts: AnswerParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  private event(lease: Lease, type: string, payload: object): BusEvent {
    return { ts: this.ts(), type, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${type}:${lease.taskKey}:${lease.leaseGen}`, payload, legacy: false }
  }

  async answer(lease: Lease): Promise<AnswerOutcome> {
    const leased = this.parts.clock().getTime()
    try {
      assertHeld(this.parts.db, lease)
      if (answerOnAnOldCardBody(this.parts.db, lease))
        return this.superseded(lease, `the body of card #${lease.cardId} was amended before this lease was taken; no session runs on the old body`)
      if (downgradeWaitOpenOn(this.parts.db, lease.cardId))
        return this.denied(lease, { kind: 'technical', reason: DOWNGRADE_WAIT_OPEN, detail: `card #${lease.cardId} waits on the owner's witness downgrade decision; no answer round runs until that wait closes` })
      const source = this.sourceOf(lease)
      if (source === null && !this.dirtyOnHead(lease))
        return this.denied(lease, { kind: 'technical', reason: 'nothing_to_answer', detail: `card #${lease.cardId} has no open question.agent stop, no changes verdict, no red CI, no red witness and no conflict with ${MAIN_BRANCH} on ${lease.head ?? 'its head'}` })
      const hold = ownerHoldOf(this.parts.db, lease.cardId)
      if (hold !== null)
        return this.heldForTheOwner(lease, hold)
      let widened: Widened | null = null
      if (source?.kind === 'question' && source.widen !== null) {
        const globs = ownerGlobs(this.parts.ownerMerges())
        const ownerPath = source.widen.paths.find(file => globs.some(glob => matchGlob(glob, file)))
        if (ownerPath !== undefined)
          return this.ownersStop(lease, `${ownerPath} is an owner path: ${source.detail}`)
        const scope = admittedScopeOf(this.parts.db, lease.cardId)
        const uncovered = scope === null ? source.widen.paths : pathsOutside(scope.touches, scope.creates, source.widen.paths)
        if (scope === null || uncovered.length > 0)
          return this.stopped(lease, QUESTION_AGENT, `${uncovered.join(', ')} not in the touches or creates the card was admitted with: ${source.detail}`, { widen: uncovered })
        const reason = `${source.widen.paths.join(', ')}, by the window's amend of the card`
        widened = { reason, paths: source.widen.paths, event: this.event(lease, SCOPE_WIDENED, { paths: source.widen.paths, admission: scope.admission, detail: source.detail }) }
      }
      const card = this.tree(lease)
      if (card === null)
        return this.denied(lease, { kind: 'technical', reason: 'no_card_tree', detail: `card #${lease.cardId} has no card.started, no start line with a worktree and a branch, and no open pull request` })
      if ('kind' in card)
        return this.denied(lease, card)
      const live = (this.parts.liveSession ?? liveSessionIn)(card)
      if (live !== null)
        return this.waitingForTheSupersededSession(lease) ?? this.heldForTheOwner(lease, live)
      const merge = source === null ? (this.parts.treeMerge ?? treeMergeOf)(card) : null
      if (merge?.kind === 'unreadable')
        return this.waiting(lease, card, merge.why)
      const answering = source ?? this.conflict(lease, card, merge)
      const sessionStart = this.parts.clock().getTime()
      let answered = await this.session(lease, answering, widened, card, false, leased)
      for (let restarts = 0; endedOnContextWarn(answered) && restarts < ANSWER_RESTARTS; restarts += 1)
        answered = await this.session(lease, answering, widened, card, true, this.parts.clock().getTime())
      if ('kind' in answered)
        return this.refusedOrDenied(lease, answered, widened)
      if (endedOnContextWarn(answered))
        return this.stopped(lease, 'fault', `continuation-limit: card #${lease.cardId} answer session ${answered.session} stopped at the context warn; ${ANSWER_RESTARTS} of ${ANSWER_RESTARTS} continuations used (D-104), the card is not continued again and the bus pushed nothing from it`, { code: 'continuation-limit' }, widened === null ? [] : [widened.event])
      return await this.settled(lease, answering, widened, card, answered, minutesSince(sessionStart, this.parts.clock().getTime()))
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private sourceOf(lease: Lease): Answering | null {
    const source = answerSourceOf(this.parts.db, lease, this.parts.clock())
    if (source?.kind === 'question')
      return { ...source, decisions: [...source.decisions, ...this.closedWaitLines(lease)] }
    if (source !== null && source.kind !== 'ci')
      return source
    const witness = this.redWitness(lease)
    if (witness === null)
      return source
    return source === null ? witness : { ...witness, failedChecks: source.failedChecks }
  }

  private redWitness(lease: Lease): Answering & { kind: 'changes' } | null {
    if (lease.pr === null || lease.head === null)
      return null
    const red = this.parts.db.prepare(RED_WITNESS_ON_HEAD).get(lease.pr, lease.head) as { detail: unknown } | undefined
    if (red === undefined)
      return null
    const detail = typeof red.detail === 'string' && red.detail !== '' ? red.detail : 'the bus recorded no detail'
    return { kind: 'changes', findings: [`the card's witness is red on ${lease.head}: ${detail}`], events: [], decisions: this.boundDecisions(lease), reentry: true }
  }

  private boundDecisions(lease: Lease): string[] {
    return boundDecisionLines(this.parts.db, lease.cardId, this.parts.clock())
  }

  private closedWaitLines(lease: Lease): string[] {
    const closed = this.parts.db.prepare(CLOSED_WAITS_OF_THE_CARD).all(lease.cardId) as { id: string, answer: string | null }[]
    return closed.map(wait => `${wait.id} is closed: ${wait.answer ?? 'no answer recorded'}`)
  }

  private dirtyOnHead(lease: Lease): boolean {
    return lease.pr !== null && lease.head !== null && this.parts.db.prepare(DIRTY_ON_HEAD).get(lease.pr, lease.head) !== undefined
  }

  private conflict(lease: Lease, card: CardSession, merge: TreeMerge | null): AnswerSource {
    const conflicts = `pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head}`
    const decisions = this.boundDecisions(lease)
    if (merge?.kind !== 'mid-merge')
      return { kind: 'changes', findings: [`${conflicts}: merge origin/${MAIN_BRANCH} into the branch and resolve every conflict, keeping what the card asks for`], events: [], decisions }
    const unmerged = merge.files.length === 0 ? '' : ` with ${merge.files.join(', ')} unmerged`
    return { kind: 'changes', findings: [`${conflicts}, and its tree ${card.worktree} stands mid-merge${unmerged}: finish that merge where it stands, resolving every unmerged path keeping what the card asks for and staging it with git -C ${card.worktree} add, and leave the commit that concludes the merge to the bus; never git merge --abort, git reset or a new merge over it`], events: [], decisions }
  }

  private waiting(lease: Lease, card: CardSession, why: string): AnswerOutcome {
    const detail = `pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head}, and the tree ${card.worktree} of card #${lease.cardId} cannot be read to answer it: ${why}`
    completeTask(this.parts.db, this.ts(), lease, [])
    const wait = openBusWait(this.parts.db, this.ts(), lease.actor, { need: 'decision', text: detail, card: lease.cardId, ...(lease.pr === null ? {} : { pr: lease.pr }) })
    return { kind: 'waiting', taskKey: lease.taskKey, wait, detail }
  }

  private tree(lease: Lease): CardSession | AnswerDenial | null {
    try {
      return cardTreeOf(this.parts.db, lease.cardId, this.parts.trees ?? realCardTrees())
    }
    catch (error) {
      if (error instanceof CardTreeRefused)
        return { kind: 'technical', reason: 'answer_failed', detail: error.message }
      return { kind: 'technical', reason: 'answer_failed', detail: `the tree of card #${lease.cardId} could not be recreated: ${messageOf(error)}` }
    }
  }

  private async session(lease: Lease, source: AnswerSource, widened: Widened | null, card: CardSession, fresh: boolean, leased: number): Promise<Answered | AnswerDenial> {
    const preparing = this.parts.clock().getTime()
    const unprepared = prepareBeforeSession(card.worktree, this.parts.prepare ?? prepareTree)
    if (unprepared !== null)
      console.error(`${PREFIX}card #${lease.cardId}: ${unprepared}`)
    const prepared = this.parts.clock().getTime()
    const beforeTheSession = { lease: secondsOf(preparing - leased), tree: secondsOf(prepared - preparing) }
    this.recordSteps(lease, preparing, beforeTheSession)
    try {
      const answered = await this.parts.answerer({ lease, source, widened: widened?.reason ?? null, card, fresh, outsideTouches: this.outsideTouchesOf(lease, widened), concept: this.conceptOf(lease, widened), stepped: steps => this.recordSteps(lease, preparing, steps) })
      return answered.steps === undefined ? answered : { ...answered, steps: { ...beforeTheSession, ...answered.steps } }
    }
    catch (error) {
      return { kind: 'technical', reason: reasonOfFailure(error), detail: messageOf(error) }
    }
  }

  private recordSteps(lease: Lease, sessionStart: number, steps: Partial<StepSeconds>): void {
    try {
      assertHeld(this.parts.db, lease)
      for (const [step, seconds] of Object.entries(steps))
        appendEvent(this.parts.db, { ...this.event(lease, ANSWER_STEP, { step, seconds }), dedupeKey: `${ANSWER_STEP}:${lease.taskKey}:${lease.leaseGen}:${sessionStart}:${step}` })
    }
    catch (error) {
      console.error(`${PREFIX}card #${lease.cardId}: the steps of the round were not recorded: ${messageOf(error)}`)
    }
  }

  private outsideTouchesOf(lease: Lease, widened: Widened | null): (paths: readonly string[]) => string[] {
    const scope = admittedScopeOf(this.parts.db, lease.cardId)
    const widenedPaths = widened?.paths ?? []
    return paths => scope === null ? [...paths] : pathsOutside([...scope.touches, ...widenedPaths], scope.creates, paths)
  }

  private conceptOf(lease: Lease, widened: Widened | null): CardConcept | null {
    const scope = admittedScopeOf(this.parts.db, lease.cardId)
    if (scope === null || activeWindowShards(this.parts.db, this.parts.clock()).length === 0)
      return null
    return { touches: [...scope.touches, ...(widened?.paths ?? [])], creates: scope.creates, ownerPath: file => this.namesAnOwnerPath([file]) }
  }

  private widenedInConcept(lease: Lease, answered: Answered): BusEvent[] {
    const paths = answered.widenedInConcept ?? []
    const scope = admittedScopeOf(this.parts.db, lease.cardId)
    if (paths.length === 0 || scope === null)
      return []
    return [{ ...this.event(lease, SCOPE_WIDENED, { paths, admission: scope.admission, detail: CONCEPT_WIDENING_REASON }), dedupeKey: `${SCOPE_WIDENED}:concept:${lease.taskKey}:${lease.leaseGen}` }]
  }

  private refusedOrDenied(lease: Lease, denial: AnswerDenial, widened: Widened | null): AnswerOutcome {
    if (denial.reason !== 'outside_touches')
      return this.denied(lease, denial)
    return this.ownersStop(lease, `${denial.detail}; the refused changes stay uncommitted in the card tree until the touches are widened or the changes are dropped`, widened === null ? [] : [widened.event], undefined, this.refusedPathsToWiden(denial.detail))
  }

  private refusedPathsToWiden(refusal: string): string[] {
    const refused = pathsIn(refusal)
    return this.namesAnOwnerPath(refused) ? [] : refused
  }

  private heldForTheOwner(lease: Lease, detail: string): AnswerOutcome {
    return this.denied(lease, { kind: 'technical', reason: 'held_for_owner', detail: `${detail}; the answer node takes no card the owner holds` })
  }

  private async settled(lease: Lease, source: Answering, widened: Widened | null, card: CardSession, answered: Answered, minutes: number): Promise<AnswerOutcome> {
    const scope = [...(widened === null ? [] : [widened.event]), ...this.widenedInConcept(lease, answered)]
    if (answered.after === null || answered.after === answered.before) {
      if (answered.owner !== null)
        return this.asked(lease, answered.owner, widened, card)
      if ((this.parts.dirty ?? treeDirtyOf)(card))
        return this.leftDirty(lease, card, answered.session)
      return this.published(lease, source, card, answered, minutes, scope) ?? this.leftNothing(lease, answered, scope)
    }
    const reentry = REENTRY_SOURCES.has(source.kind) || source.reentry === true
    const payload = { session: answered.session, worktree: card.worktree, resumed: answered.resumed, source: source.kind, from: answered.before, to: answered.after, ...(reentry ? { reentry: true } : {}), ...measurementOf(answered, minutes), ...stepsOf(answered), ...storedInput(this.parts.prompts, answered.input), ...cardBodyOf(answered.input) }
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_ANSWERED, payload)])
    return { kind: 'answered', taskKey: lease.taskKey, session: answered.session, resumed: answered.resumed, head: answered.after }
  }

  private prOfTheCard(cardId: number): number | null {
    const row = this.parts.db.prepare(A_PR_OF_THE_CARD).get({ card: cardId }) as { pr: number } | undefined
    return row === undefined ? null : Number(row.pr)
  }

  private published(lease: Lease, source: Answering, card: CardSession, answered: Answered, minutes: number, scope: BusEvent[]): AnswerOutcome | null {
    const publishing = this.parts.publishing
    if (publishing === undefined || this.prOfTheCard(lease.cardId) !== null || !publishing.committed(card))
      return null
    assertHeld(this.parts.db, lease)
    publishing.publish(card, lease.cardId)
    const pr = this.prOfTheCard(lease.cardId)
    if (pr === null)
      return null
    const payload = { session: answered.session, worktree: card.worktree, resumed: answered.resumed, source: source.kind, from: answered.before, to: answered.after, published: true, pr, ...measurementOf(answered, minutes), ...stepsOf(answered), ...storedInput(this.parts.prompts, answered.input), ...cardBodyOf(answered.input) }
    const linkAfterTheStopLifts: BusEvent = { ...this.event(lease, PR_OPENED, { pr }), pr }
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_ANSWERED, payload), linkAfterTheStopLifts])
    return { kind: 'published', taskKey: lease.taskKey, session: answered.session, pr }
  }

  private leftDirty(lease: Lease, card: CardSession, session: string): AnswerOutcome {
    return this.denied(lease, { kind: 'technical', reason: 'answer_failed', detail: `the answer session ${session} pushed nothing and left uncommitted changes in ${card.worktree}; the answer goes again over that tree` })
  }

  private leftNothing(lease: Lease, answered: Answered, scope: BusEvent[]): AnswerOutcome {
    const cause = `the answer session ${answered.session} left ${lease.taskKey} at ${answered.after ?? 'no pushed head'} with no new commit, no owner question and a clean tree`
    const empty = this.emptyAnswersInARow(lease) + 1
    const failures = this.failuresInARow(lease) + 1
    if (empty < REVIEW_ROUNDS && failures < FAILURES_TO_STOP)
      return this.denied(lease, { kind: 'technical', reason: LEFT_NOTHING, detail: `${cause}; the answer goes again, empty answer ${empty} of the review round limit ${REVIEW_ROUNDS}` })
    const limit = empty >= REVIEW_ROUNDS
      ? `${empty} empty answers in a row reach the review round limit ${REVIEW_ROUNDS}`
      : `${empty} empty answers in a row and ${failures} failures in a row of any kind reach the ${FAILURES_TO_STOP} failures that stop the task`
    const detail = `${cause}: ${limit}, and the bus answers the card no further`
    return this.ownersStop(lease, detail, scope, `card #${lease.cardId} stands on a faulted answer: ${detail}; decide it: a re-cut, an amend of the card or a drop`)
  }

  private emptyAnswersInARow(lease: Lease): number {
    return Number((this.parts.db.prepare(EMPTY_ANSWERS_IN_A_ROW).get({ prefix: `${POLICY_DENIED}:${lease.taskKey}:` }) as { n: number }).n)
  }

  private failuresInARow(lease: Lease): number {
    const row = this.parts.db.prepare(FAILURES_IN_A_ROW).get(lease.taskKey) as { failures: number } | undefined
    return row?.failures ?? 0
  }

  private staleQuestion(lease: Lease, question: string): AnswerOutcome | null {
    if (answerOnAnOldCardBody(this.parts.db, lease))
      return this.superseded(lease, `the body of card #${lease.cardId} was amended while the answer session ran; no owner question is written, and the answer goes again on the new body. The question was: ${question}`)
    const closed = [...new Set(question.match(NAMES_A_WAIT) ?? [])].filter(id => this.parts.db.prepare(IS_A_CLOSED_WAIT).get(id) !== undefined)
    if (closed.length === 0)
      return null
    return this.denied(lease, { kind: 'technical', reason: 'closed_wait', detail: `the answer session named ${closed.join(', ')}, already closed; no owner question is written, and the answer goes again with the closed waits of the card in its prompt. The question was: ${question}` })
  }

  private async asked(lease: Lease, question: string, widened: Widened | null, card: CardSession): Promise<AnswerOutcome> {
    const stale = this.staleQuestion(lease, question)
    if (stale !== null)
      return stale
    const answeredBy = decisionAnsweringRepeat(this.parts.db, lease.cardId, question, this.parts.clock())
    if (answeredBy !== null)
      return this.denied(lease, { kind: 'technical', reason: 'repeated_stop', detail: `the answer session asked again what card #${lease.cardId} already stopped on, and D-${answeredBy} was recorded for the card after that stop; no new owner wait, the answer goes again with the decision in its prompt. The question was: ${question}` })
    const scope = widened === null ? [] : [widened.event]
    if (downgradeWaitOpenOn(this.parts.db, lease.cardId))
      return this.ownersStop(lease, question, scope)
    if (!this.ownersQuestion(lease, question))
      return this.stopped(lease, QUESTION_AGENT, question, {}, scope)
    const shard = activeDecisionsShard(this.parts.db, this.parts.clock())
    if (shard === null || reservationOf(lease.cardId, question))
      return this.ownersStop(lease, question, scope)
    const reserved = ownersUnderAnyShard(question)
    if (reserved !== null)
      return this.ownersStop(lease, `${question} (${reserved} stays the owner's under any shard)`, scope)
    const boundary = ownersEvenUnderTheDecision(pathsIn(question))
    if (boundary !== undefined)
      return this.ownersStop(lease, `${question} (${boundary} is ${OWNER_EVEN_UNDER_THE_DECISION} and stays the owner's under any shard)`, scope)
    const isolation: Isolation = this.parts.isolation?.() ?? { level: 'none', why: 'the answer worker reads no isolation' }
    if (isolation.level === 'none')
      return this.ownersStop(lease, `${question} (the ${DECISIONS_SCOPE} shard ${shard.id} is refused without isolation: ${isolation.why})`, scope)
    const ground = `window shard ${shard.id} (${shard.scope}, by ${shard.by}, until ${shard.until}) under ${isolation.level} isolation`
    const decision = this.parts.shardDecider?.(lease, question) ?? null
    if (decision === null || decision.answer.trim() === '')
      return this.ownersStop(lease, heldForTheWindow(question, shard.id, 'the bus has no decision text for it, and a shard decision without one is refused'), scope)
    assertHeld(this.parts.db, lease)
    appendEvent(this.parts.db, this.event(lease, SHARD_DECIDED, { shard: shard.id, question, ground, options: DECISION_OPTIONS, answer: decision.answer, ...(decision.doneBy === undefined ? {} : { doneBy: decision.doneBy }) }))
    const decidedSource = decisionSource(question, ground, decision, this.boundDecisions(lease))
    const decided = await this.session(lease, decidedSource, widened, card, false, this.parts.clock().getTime())
    if ('kind' in decided)
      return this.refusedOrDenied(lease, decided, widened)
    if (!leftNoNewHead(decided))
      return this.settled(lease, decidedSource, widened, card, decided, 0)
    if (decided.owner !== null)
      return this.staleQuestion(lease, decided.owner) ?? this.ownersStop(lease, heldForTheWindow(decided.owner, shard.id, `the session could not act on the decision of: ${question}`), scope)
    if ((this.parts.dirty ?? treeDirtyOf)(card))
      return this.leftDirty(lease, card, decided.session)
    completeTask(this.parts.db, this.ts(), lease, scope)
    return { kind: 'decided', taskKey: lease.taskKey, shard: shard.id, question }
  }

  private ownersQuestion(lease: Lease, question: string): boolean {
    const decisions = decisionsInForceAt(this.parts.db, this.parts.clock())
    if ([question, ...decisions.map(decision => decision.text)].some(text => reservationOf(lease.cardId, text)))
      return true
    if (unspentShard(this.parts.db, lease.cardId, lease.pr, decisions) !== null)
      return false
    return this.namesAnOwnerPath(pathsIn(question))
  }

  private namesAnOwnerPath(named: readonly string[]): boolean {
    const globs = ownerGlobs(this.parts.ownerMerges())
    return ownersEvenUnderTheDecision(named) !== undefined || named.some(file => globs.some(glob => matchGlob(glob, file)))
  }

  private stopped(lease: Lease, reason: string, detail: string, extra: Record<string, unknown> = {}, scope: BusEvent[] = [], inTheSameCommit: (db: DatabaseSync) => void = () => {}): AnswerOutcome {
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_STOPPED, { reason, detail, ...extra })], inTheSameCommit)
    return { kind: 'stopped', taskKey: lease.taskKey, reason, detail }
  }

  private ownersStop(lease: Lease, detail: string, scope: BusEvent[] = [], text = `card #${lease.cardId} asks: ${detail}`, widen = this.windowWidens(lease, detail)): AnswerOutcome {
    const ask = { need: 'decision' as const, text, command: cardDecisionCommand(lease.cardId), card: lease.cardId, ...(lease.pr === null ? {} : { pr: lease.pr }) }
    return this.stopped(lease, QUESTION_OWNER, detail, widen.length === 0 ? {} : { widen }, scope, db => openBusWait(db, this.ts(), lease.actor, ask))
  }

  private windowWidens(lease: Lease, question: string): string[] {
    if (this.namesAnOwnerPath(pathsIn(question)))
      return []
    const shard = unspentShard(this.parts.db, lease.cardId, lease.pr, decisionsInForceAt(this.parts.db, this.parts.clock()))
    return scopeWideningAsked(question, admittedScopeOf(this.parts.db, lease.cardId), shard !== null)
  }

  private denialEvent(lease: Lease, denial: AnswerDenial): BusEvent {
    return { ...this.event(lease, POLICY_DENIED, { command: 'answer', ...denial }), actor: 'policy' }
  }

  private denied(lease: Lease, denial: AnswerDenial): AnswerOutcome {
    const next = failTask(this.parts.db, this.ts(), lease, { reason: denial.reason, withdraw: WITHDRAWN_REASONS.has(denial.reason) }, [this.denialEvent(lease, denial)])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }

  private superseded(lease: Lease, detail: string): AnswerOutcome {
    const denial: AnswerDenial = { kind: 'technical', reason: 'old_card_body', detail }
    return { kind: 'denied', taskKey: lease.taskKey, denial, next: supersedeLease(this.parts.db, this.ts(), lease, [this.denialEvent(lease, denial)]) }
  }

  private waitingForTheSupersededSession(lease: Lease): AnswerOutcome | null {
    if (!supersededAnswerWithinItsLease(this.parts.db, lease.cardId, this.ts()))
      return null
    const until = new Date(this.parts.clock().getTime() + TICK_MS).toISOString()
    waitTask(this.parts.db, this.ts(), lease, { reason: SUPERSEDED_SESSION_ENDING, until })
    return { kind: 'waiting', taskKey: lease.taskKey, reason: SUPERSEDED_SESSION_ENDING, until }
  }
}
