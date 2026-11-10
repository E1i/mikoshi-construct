import type { DatabaseSync } from 'node:sqlite'
import type { QueueTaskRow } from '../../core/card-hold.js'
import type { BusEvent } from '../../core/db.js'
import type { Lease } from '../../core/lease.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeMain } from '../../ports/main-merge.js'
import type { TreePreparer } from '../../ports/prepare-tree.js'
import type { AdmittedScope, AnswerSource, CardSession } from './answer-source.js'
import type { Answered, Answerer, StepSeconds } from './answerer.js'
import type { CardConcept } from './concept-scope.js'
import type { AnswerDenial, Answering, AnswerOutcome, AnswerTechnicalReason, CardPaths, DecidedRound, ShardDecider, TreeMerge, TreePublishing, Widened } from './duties/index.js'
import { pathsIn, pathsOutside } from '../../../src/card/covering-tests.js'
import { riskOf } from '../../../src/card/risk.js'
import { answersWithdrawnByAClosedHold, holdRecheckAt, LIVE_SESSION_IN_THE_TREE, queueAgain } from '../../core/card-hold.js'
import { appendEvent, inTransaction, openBusWait } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { ANSWER_STEP, CARD_ANSWERED, CARD_RELEASED, QUESTION_AGENT, SCOPE_WIDENED } from '../../core/events.js'
import { assertHeld, completeTask, StaleLease, waitTask } from '../../core/lease.js'
import { timeoutUnderLoadOutside } from '../../core/observations.js'
import { answerOnAnOldCardBody, DOWNGRADE_WAIT_OPEN, downgradeWaitOpenOn, LEASED, QUEUED } from '../../core/queue.js'
import { OWNER_EVEN_UNDER_THE_DECISION } from '../../policy/policy.js'
import { matchGlob } from '../../policy/shredder/glob.js'
import { ownerGlobs } from '../../policy/widening.js'
import { cardTreeOf, CardTreeRefused, realCardTrees } from '../../ports/card-tree.js'
import { conflictingCardOf, mainKeptInTheTree } from '../../ports/main-merge.js'
import { prepareBeforeSession, prepareTree } from '../../ports/prepare-tree.js'
import { MAIN_BRANCH } from '../../ports/snapshot.js'
import { admittedScopeOf, decisionAnsweringRepeat, ownerHoldOf } from './answer-source.js'
import { AnswerOutsideTouches, CardTreeGone, liveSessionIn, PREFIX, secondsOf } from './answerer.js'
import { CONCEPT_WIDENING_REASON } from './concept-scope.js'
import { AnswerOutcomes, AnswerPublishing, AnswerSources, leftNoNewHead, OwnerQuestions, treeDirtyOf, treeMergeOf } from './duties/index.js'

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
  mergeMain?: (tree: string) => MergeMain
}

const REENTRY_SOURCES: ReadonlySet<AnswerSource['kind']> = new Set(['ci'])

export const ANSWER_RESTARTS = 3

const MS_PER_MINUTE = 60_000

function minutesSince(start: number, end: number): number {
  return Math.round((end - start) / MS_PER_MINUTE * 10) / 10
}

function endedOnContextWarn(answered: Answered | AnswerDenial): boolean {
  return !('kind' in answered) && answered.atContextWarn === true && answered.owner === null && leftNoNewHead(answered)
}

function reasonOfFailure(error: unknown): AnswerTechnicalReason {
  if (error instanceof CardTreeGone)
    return 'card_tree_gone'
  return error instanceof AnswerOutsideTouches ? 'outside_touches' : 'answer_failed'
}

const ASKS_ABOUT_THE_SCOPE = /\b(?:touches|creates|scope)\b/i

function ownersEvenUnderTheDecision(paths: readonly string[]): string | undefined {
  return paths.find(file => riskOf(file).level === OWNER_EVEN_UNDER_THE_DECISION)
}

export function scopeWideningAsked(question: string, scope: AdmittedScope | null, underAShard: boolean): string[] {
  return !underAShard || scope === null || !ASKS_ABOUT_THE_SCOPE.test(question) ? [] : pathsOutside(scope.touches, scope.creates, pathsIn(question))
}

export function questionAskedTwiceLine(cardId: number, question: string): string {
  return `card #${cardId} asks twice in a row, its answer session repeating the question its ${QUESTION_AGENT} stop already carried; another answer round would ask it again, so the card waits for the owner: ${question}`
}

const CARD_PATHS: CardPaths = { pathsIn, ownerBoundary: ownersEvenUnderTheDecision, wideningAsked: scopeWideningAsked }

export class AnswerExecutor {
  private readonly outcomes: AnswerOutcomes
  private readonly sources: AnswerSources
  private readonly publishing: AnswerPublishing
  private readonly questions: OwnerQuestions

  constructor(private readonly parts: AnswerParts) {
    this.outcomes = new AnswerOutcomes(parts, CARD_PATHS)
    this.sources = new AnswerSources(parts)
    this.publishing = new AnswerPublishing(parts, this.outcomes)
    this.questions = new OwnerQuestions(parts, CARD_PATHS, this.outcomes, this.sources, this.publishing)
  }

  private ts(): string {
    return this.outcomes.ts()
  }

  async answer(lease: Lease): Promise<AnswerOutcome> {
    const leased = this.parts.clock().getTime()
    try {
      assertHeld(this.parts.db, lease)
      if (answerOnAnOldCardBody(this.parts.db, lease))
        return this.outcomes.superseded(lease, `the body of card #${lease.cardId} was amended before this lease was taken; no session runs on the old body`)
      if (downgradeWaitOpenOn(this.parts.db, lease.cardId))
        return this.outcomes.denied(lease, { kind: 'technical', reason: DOWNGRADE_WAIT_OPEN, detail: `card #${lease.cardId} waits on the owner's witness downgrade decision; no answer round runs until that wait closes` })
      const source = this.sources.sourceOf(lease)
      if (source === null && !this.sources.dirtyOnHead(lease))
        return this.outcomes.denied(lease, { kind: 'technical', reason: 'nothing_to_answer', detail: `card #${lease.cardId} has no open question.agent stop, no changes verdict, no red CI, no red witness and no conflict with ${MAIN_BRANCH} on ${lease.head ?? 'its head'}` })
      const hold = ownerHoldOf(this.parts.db, lease.cardId)
      if (hold !== null)
        return this.withdrawnUnderTheHold(lease, hold)
      let widened: Widened | null = null
      if (source?.kind === 'question' && source.widen !== null) {
        const globs = ownerGlobs(this.parts.ownerMerges())
        const ownerPath = source.widen.paths.find(file => globs.some(glob => matchGlob(glob, file)))
        if (ownerPath !== undefined)
          return this.outcomes.ownersStop(lease, `${ownerPath} is an owner path: ${source.detail}`)
        const scope = admittedScopeOf(this.parts.db, lease.cardId)
        const uncovered = scope === null ? source.widen.paths : pathsOutside(scope.touches, scope.creates, source.widen.paths)
        if (scope === null || uncovered.length > 0)
          return this.outcomes.stopped(lease, QUESTION_AGENT, `${uncovered.join(', ')} not in the touches or creates the card was admitted with: ${source.detail}`, { widen: uncovered })
        const reason = `${source.widen.paths.join(', ')}, by the window's amend of the card`
        widened = { reason, paths: source.widen.paths, event: this.outcomes.event(lease, SCOPE_WIDENED, { paths: source.widen.paths, admission: scope.admission, detail: source.detail }) }
      }
      const card = this.tree(lease)
      if (card === null)
        return this.outcomes.denied(lease, { kind: 'technical', reason: 'no_card_tree', detail: `card #${lease.cardId} has no card.started, no start line with a worktree and a branch, and no open pull request` })
      if ('kind' in card)
        return this.outcomes.denied(lease, card)
      const live = (this.parts.liveSession ?? liveSessionIn)(card)
      if (live !== null)
        return this.outcomes.waitingForTheSupersededSession(lease) ?? this.waitingForTheLiveSession(lease, live)
      if (source !== null)
        this.mainMergedBeforeTheSession(lease, card)
      const merge = source === null ? (this.parts.treeMerge ?? treeMergeOf)(card) : null
      if (merge?.kind === 'unreadable')
        return this.waiting(lease, card, merge.why)
      const answering = source ?? this.sources.conflict(lease, card, merge)
      const sessionStart = this.parts.clock().getTime()
      let answered = await this.session(lease, answering, widened, card, false, leased)
      for (let restarts = 0; endedOnContextWarn(answered) && restarts < ANSWER_RESTARTS; restarts += 1)
        answered = await this.session(lease, answering, widened, card, true, this.parts.clock().getTime())
      if ('kind' in answered)
        return this.refusedOrDenied(lease, answered, widened)
      if (endedOnContextWarn(answered))
        return this.outcomes.stopped(lease, 'fault', `continuation-limit: card #${lease.cardId} answer session ${answered.session} stopped at the context warn; ${ANSWER_RESTARTS} of ${ANSWER_RESTARTS} continuations used (D-104), the card is not continued again and the bus pushed nothing from it`, { code: 'continuation-limit' }, widened === null ? [] : [widened.event])
      return await this.settled(lease, answering, widened, card, answered, minutesSince(sessionStart, this.parts.clock().getTime()))
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private withdrawnUnderTheHold(lease: Lease, hold: string): AnswerOutcome {
    const outcome = this.outcomes.heldForTheOwner(lease, hold)
    const requeued = inTransaction(this.parts.db, () => answersQueuedAfterALateRelease(this.parts.db, this.ts(), lease.cardId))
    if (requeued.length > 0)
      console.log(`${PREFIX}card #${lease.cardId}: its hold was released while ${lease.taskKey} was withdrawn under it; queued again: ${requeued.join(', ')}`)
    return outcome
  }

  private mainMergedBeforeTheSession(lease: Lease, card: CardSession): void {
    if (lease.head === null)
      return
    const mergeMain = (this.parts.mergeMain ?? mainKeptInTheTree)(card.worktree)
    const merged = mergeMain(conflictingCardOf(this.parts.db, lease.cardId, card.branch, lease.head))
    if (merged.kind === 'merged' && merged.to !== lease.head)
      console.log(`${PREFIX}card #${lease.cardId}: ${MAIN_BRANCH} merged into ${card.worktree} at ${merged.to} before the answer session`)
  }

  private waitingForTheLiveSession(lease: Lease, live: string): AnswerOutcome {
    const until = holdRecheckAt(this.parts.clock())
    console.log(`${PREFIX}card #${lease.cardId}: ${live}; the answer waits until ${until} and goes once that session ends`)
    waitTask(this.parts.db, this.ts(), lease, { reason: LIVE_SESSION_IN_THE_TREE, until })
    return { kind: 'waiting', taskKey: lease.taskKey, reason: LIVE_SESSION_IN_THE_TREE, until }
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
      const answered = await this.parts.answerer({ lease, source, widened: widened?.reason ?? null, card, fresh, outsideTouches: this.outsideTouchesOf(lease, widened), concept: this.conceptOf(lease), stepped: steps => this.recordSteps(lease, preparing, steps) })
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
        appendEvent(this.parts.db, { ...this.outcomes.event(lease, ANSWER_STEP, { step, seconds }), dedupeKey: `${ANSWER_STEP}:${lease.taskKey}:${lease.leaseGen}:${sessionStart}:${step}` })
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

  private conceptOf(lease: Lease): CardConcept | null {
    const scope = admittedScopeOf(this.parts.db, lease.cardId)
    if (scope === null)
      return null
    return { touches: scope.touches, creates: scope.creates, ownerPath: file => this.outcomes.namesAnOwnerPath([file]) }
  }

  private widenedInConcept(lease: Lease, answered: Answered): BusEvent[] {
    const paths = answered.widenedInConcept ?? []
    const scope = admittedScopeOf(this.parts.db, lease.cardId)
    if (paths.length === 0 || scope === null)
      return []
    return [{ ...this.outcomes.event(lease, SCOPE_WIDENED, { paths, admission: scope.admission, detail: CONCEPT_WIDENING_REASON }), dedupeKey: `${SCOPE_WIDENED}:concept:${lease.taskKey}:${lease.leaseGen}` }]
  }

  private refusedOrDenied(lease: Lease, denial: AnswerDenial, widened: Widened | null): AnswerOutcome {
    if (denial.reason !== 'outside_touches')
      return this.outcomes.denied(lease, denial)
    return this.outcomes.ownersStop(lease, `${denial.detail}; the refused changes stay uncommitted in the card tree until the touches are widened or the changes are dropped`, widened === null ? [] : [widened.event], undefined, this.refusedPathsToWiden(denial.detail))
  }

  private refusedPathsToWiden(refusal: string): string[] {
    const refused = pathsIn(refusal)
    return this.outcomes.namesAnOwnerPath(refused) ? [] : refused
  }

  private dirty(card: CardSession): boolean {
    return (this.parts.dirty ?? treeDirtyOf)(card)
  }

  private async settled(lease: Lease, source: Answering, widened: Widened | null, card: CardSession, answered: Answered, minutes: number): Promise<AnswerOutcome> {
    const scope = [...(widened === null ? [] : [widened.event]), ...this.widenedInConcept(lease, answered)]
    if (answered.after === null || answered.after === answered.before) {
      if (answered.owner !== null && answered.noViolationFreePath === true)
        return this.outcomes.ownersStop(lease, answered.owner, scope)
      if (answered.owner !== null && !timeoutUnderLoadOutside(answered.owner, this.outsideTouchesOf(lease, widened)))
        return this.questions.staleQuestion(lease, answered.owner) ?? this.askedTwiceInARow(lease, source, answered.owner, scope) ?? await this.questions.asked(lease, answered.owner, widened, card, this.decidedRound(lease, widened, card))
      if (this.dirty(card))
        return this.publishing.leftDirty(lease, card, answered.session)
      return this.publishing.published(lease, source, card, answered, minutes, scope) ?? this.publishing.leftNothing(lease, answered, scope)
    }
    const reentry = REENTRY_SOURCES.has(source.kind) || source.reentry === true
    const payload = this.publishing.answeredPayload(source, card, answered, minutes, reentry ? { reentry: true } : {})
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.outcomes.event(lease, CARD_ANSWERED, payload)])
    return { kind: 'answered', taskKey: lease.taskKey, session: answered.session, resumed: answered.resumed, head: answered.after }
  }

  private askedTwiceInARow(lease: Lease, source: Answering, question: string, scope: BusEvent[]): AnswerOutcome | null {
    if (source.kind !== 'question' || source.detail.trim() !== question.trim())
      return null
    if (decisionAnsweringRepeat(this.parts.db, lease.cardId, question, this.parts.clock()) !== null)
      return null
    return this.outcomes.ownersStop(lease, question, scope, questionAskedTwiceLine(lease.cardId, question))
  }

  private decidedRound(lease: Lease, widened: Widened | null, card: CardSession): DecidedRound {
    return {
      run: async source => this.session(lease, source, widened, card, false, this.parts.clock().getTime()),
      refusedOrDenied: denial => this.refusedOrDenied(lease, denial, widened),
      settled: async (source, answered) => this.settled(lease, source, widened, card, answered, 0),
      dirty: () => this.dirty(card),
    }
  }
}

const LATEST_RELEASE_OF_CARD = `SELECT id, json_extract(payload, '$.request') AS request FROM events WHERE card_id = ? AND legacy = 0 AND type = '${CARD_RELEASED}' ORDER BY id DESC LIMIT 1`

function answersQueuedAfterALateRelease(db: DatabaseSync, ts: string, cardId: number): string[] {
  const release = db.prepare(LATEST_RELEASE_OF_CARD).get(cardId) as { id: number, request: unknown } | undefined
  if (release === undefined || ownerHoldOf(db, cardId) !== null)
    return []
  const missed = answersWithdrawnByAClosedHold(db, cardId, Number(release.id))
  const request = typeof release.request === 'number' ? release.request : null
  missed.forEach(task => queueAgain(db, ts, task, request, `${CARD_RELEASED}-${Number(release.id)}`))
  return missed.map(task => task.task_key)
}

const LATEST_ANSWER_OF_CARD = `SELECT task_key, queue, card_id, pr, head, state FROM tasks WHERE card_id = ? AND queue = 'answer' ORDER BY id DESC LIMIT 1`

export interface AmendedStop {
  id: number
  payload: string
}

function touchesAfterAmend(admitted: readonly string[], delta: string | null): Set<string> {
  const touches = new Set(admitted)
  for (const entry of (delta ?? '').split(',').map(each => each.trim()).filter(each => each !== '')) {
    if (entry.startsWith('-'))
      touches.delete(entry.slice(1))
    else
      touches.add(entry.replace(/^\+/, ''))
  }
  return touches
}

export function answerToResumeAfterAmend(db: DatabaseSync, cardId: number, stop: AmendedStop, delta: string | null): QueueTaskRow | string {
  const asked = (JSON.parse(stop.payload) as { widen?: unknown }).widen
  const widen = Array.isArray(asked) ? asked.filter((each): each is string => typeof each === 'string') : []
  const scope = admittedScopeOf(db, cardId)
  const uncovered = pathsOutside([...touchesAfterAmend(scope?.touches ?? [], delta)], scope?.creates ?? [], widen)
  if (widen.length === 0 || uncovered.length > 0)
    return `the stop ${stop.id} stays: card #${cardId} waits for ${widen.length === 0 ? 'the owner\'s answer to its question' : `touches that cover ${uncovered.join(', ')}`}, lifted by the owner's decision with --card #${cardId} or an amend`
  const task = db.prepare(LATEST_ANSWER_OF_CARD).get(cardId) as QueueTaskRow | undefined
  if (task === undefined)
    return `the stop ${stop.id} is settled and card #${cardId} has no answer task to resume: it waits for the bus to derive one from its pull request, or for the window's takeover`
  return task.state === QUEUED || task.state === LEASED ? `the answer ${task.task_key} is ${task.state} already` : task
}
