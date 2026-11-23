import type { DatabaseSync } from 'node:sqlite'
import type { QueueTaskRow } from '../../core/card-hold.js'
import type { BusEvent } from '../../core/db.js'
import type { CardTransitions, CarriedTree, Lease } from '../../core/lease.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeMain } from '../../ports/main-merge.js'
import type { TreePreparer } from '../../ports/prepare-tree.js'
import type { AdmittedScope, AnswerSource, CardSession } from './answer-source.js'
import type { Answered, Answerer, StepSeconds } from './answerer.js'
import type { CardConcept } from './concept-scope.js'
import type { AnswerDenial, Answering, AnswerOutcome, AnswerTechnicalReason, CardPaths, DecidedRound, ShardDecider, StrandedAnswer, TreeMerge, TreePublishing, Widened } from './duties/index.js'
import type { TreeOwned, TreePushPolicy } from './duties/tree.js'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { riskOf } from '../../../src/card/risk.js'
import { pathsOutsideTheBody } from '../../core/card-bodies.js'
import { answersWithdrawnByAClosedHold, holdRecheckAt, LIVE_SESSION_IN_THE_TREE, queueAgain, sessionStopOf } from '../../core/card-hold.js'
import { closedWaitIds } from '../../core/card-readings.js'
import { appendEvent, inTransaction, openBusWait } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { ANSWER_STEP, CARD_ANSWERED, CARD_RELEASED, OUTSIDE_TOUCHES, OWNER_WAIT_CLOSED, POLICY_DENIED, QUESTION_AGENT, SCOPE_WIDENED } from '../../core/events.js'
import { assertHeld, completeTask, cutByRestart, failTask, releaseTask, RESTART_CUT, StaleLease, waitTask } from '../../core/lease.js'
import { timeoutUnderLoadOutside } from '../../core/observations.js'
import { answerOnAnOldCardBody, DOWNGRADE_WAIT_OPEN, downgradeWaitOpenOn, latestAnswerOf, latestReleaseOf, latestWidenStopOf, LEASED, openDecisionWaitsOfCard, QUEUED } from '../../core/queue.js'
import { OWNER_EVEN_UNDER_THE_DECISION } from '../../policy/policy.js'
import { matchGlob } from '../../policy/shredder/glob.js'
import { isRegisteredDerived, pathsIn, pathsOutside } from '../../policy/touch-scope.js'
import { ownerGlobs } from '../../policy/widening.js'
import { cardTreeOf, CardTreeRefused, realCardTrees } from '../../ports/card-tree.js'
import { conflictingCardOf, mainKeptInTheTree } from '../../ports/main-merge.js'
import { prepareBeforeSession, prepareTree } from '../../ports/prepare-tree.js'
import { MAIN_BRANCH } from '../../ports/snapshot.js'
import { admittedScopeOf, carriedTreeOf, decisionAnsweringRepeat, ownerHoldOf } from './answer-source.js'
import { AnswerOutsideTouches, CardTreeGone, liveSessionIn, PREFIX, secondsOf, unprovedFindings } from './answerer.js'
import { CONCEPT_WIDENING_REASON } from './concept-scope.js'
import { AnswerOutcomes, AnswerPublishing, AnswerSources, leftNoNewHead, localHead, OwnerQuestions, pendingPathsOf, strandedAnswerOf, treeDirtyOf, treeMergeOf } from './duties/index.js'
import { carriedTreeState, ownCarriedTree } from './duties/tree.js'

export interface AnswerParts {
  db: DatabaseSync
  cards: CardTransitions
  answerer: Answerer
  ownerMerges: () => string
  clock: () => Date
  silentMs: number
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
  changedInTheTree?: (card: CardSession) => string[]
  localHead?: (card: CardSession) => string | null
  treeState?: (card: CardSession, prHead: string) => CarriedTree | null
  ownTree?: (card: CardSession, prHead: string, policy: TreePushPolicy) => TreeOwned
  pushPolicy?: (card: CardSession) => TreePushPolicy
  allowances?: (cardId: number) => readonly string[]
}

export const CARRIED_TREE = 'carried-tree'

const KEPT_WITHOUT_A_KNOWN_POLICY: TreePushPolicy = 'none'

const REENTRY_SOURCES: ReadonlySet<AnswerSource['kind']> = new Set(['ci'])

export const ANSWER_RESTARTS = 3

export const ANSWER_TREE_GATE_RUN_SPOOL = path.join('.construct', 'gate-runs.jsonl')

export function drainAnswerTreeGateRuns(db: DatabaseSync, worktree: string): number {
  const spool = path.join(worktree, ANSWER_TREE_GATE_RUN_SPOOL)
  if (!existsSync(spool))
    return 0
  const events = readFileSync(spool, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as BusEvent)
  events.forEach(event => appendEvent(db, event))
  rmSync(spool, { force: true })
  return events.length
}

const MS_PER_MINUTE = 60_000

function minutesSince(start: number, end: number): number {
  return Math.round((end - start) / MS_PER_MINUTE * 10) / 10
}

function endedOnContextWarn(answered: Answered | AnswerDenial): answered is Answered {
  return !('kind' in answered) && answered.atContextWarn === true && leftNoNewHead(answered)
}

function restartsAfter(answered: Answered | AnswerDenial): boolean {
  return endedOnContextWarn(answered) && answered.owner === null
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

const RATCHET_ROW = /\b(?:boundary|law-gaps|lines-scope|lines|overlaps):[^\s,;'"`()[\]]+/g
const NUMERIC_GROWTH = /(\d+)\s*(?:→|->|=>|⟶)\s*(\d+)/g
const GROWTH_WORD = /\b(?:grow|grows|growing|grown|growth|raise|raises|raising|bump|bumps|increase|increases|lift)\b|рост|подн/i
const TRAILING_PUNCTUATION = /[.:]+$/

function asksForGrowth(question: string): boolean {
  return GROWTH_WORD.test(question) || [...question.matchAll(NUMERIC_GROWTH)].some(([, from, to]) => Number(to) > Number(from))
}

export function ratchetRowsAskedToGrow(question: string): string[] {
  const rows = [...new Set([...question.matchAll(RATCHET_ROW)].map(([row]) => row.replace(TRAILING_PUNCTUATION, '')))]
  return rows.length === 0 || !asksForGrowth(question) ? [] : rows
}

export function ratchetGrowthLine(cardId: number, rows: readonly string[], question: string): string {
  return `card #${cardId} asks to grow the ratchet row${rows.length === 1 ? '' : 's'} ${rows.join(', ')} of contract/ratchet.json; the merge policy denies ratchet growth under every shard and every decision, so only the owner answers it and no answer round runs until this wait closes: ${question}`
}

export function derivedRefusalNote(refused: readonly string[]): string {
  const derived = refused.filter(isRegisteredDerived)
  return derived.length === 0 ? '' : `${derived.join(', ')} ${derived.length === 1 ? 'is a derived file' : 'are derived files'} that the touches never widen to: the rerun of the generator did not reproduce the change, or the change grows the file, and growth is the owner's (D-592); `
}

export function changedInTheTreeOf(named: readonly string[], changed: ReadonlySet<string>): string[] {
  return named.filter(file => changed.has(file))
}

export function findingsGivenByAReview(source: Answering | null): string[] {
  return source?.kind === 'changes' && source.reentry !== true ? source.findings : []
}

export function unprovedFindingsLine(cardId: number, answered: Pick<Answered, 'before' | 'after'>, unproved: readonly string[]): string {
  const pushed = answered.after !== null && answered.after !== answered.before
  const fate = pushed ? `its head ${answered.after} was pushed without them and stays on the pull request for the next review` : `the bus pushed nothing from it, so the answer goes again on ${answered.before ?? 'the same head'}`
  return `card #${cardId}: the answer leaves ${unproved.length} given finding${unproved.length === 1 ? '' : 's'} unproved, so it is refused; ${fate}: ${unproved.join('; ')}`
}

function offFormLine(commands: readonly string[] | undefined): string {
  if (commands === undefined || commands.length === 0)
    return ''
  return `; the session ran ${commands.length === 1 ? 'a gate command' : `${commands.length} gate commands`} not in its declared form, which the bus does not record (D-627): ${commands.map(command => `\`${command}\``).join(', ')}`
}

export function noGateDecisionLine(cardId: number, answered: Pick<Answered, 'session' | 'before' | 'offFormGateCommands'>): string {
  return `card #${cardId}: the answer session ${answered.session} left work in its tree and recorded no gate decision (no outcome of every gate command, and no gate that could not run), so the bus pushed nothing from it; the answer goes again on ${answered.before ?? 'the same head'} and runs the gate${offFormLine(answered.offFormGateCommands)}`
}

const REPUBLISHED: Answering = { kind: 'question', detail: 'an answered card with a pushed head and no pull request, published by the bus', widen: null, events: [], decisions: [] }

export function strandedDirtyLine(cardId: number, stranded: StrandedAnswer, card: CardSession): string {
  return `card #${cardId} was answered at ${stranded.to} with no pull request, and its tree ${card.worktree} holds uncommitted changes; the bus publishes no tree it does not see clean, so the card is left as it is`
}

export function strandedUnpublishedLine(cardId: number, stranded: StrandedAnswer, card: CardSession): string {
  return `card #${cardId} was answered at ${stranded.to} with no pull request, and the bus could not publish ${card.branch}: the tree has no committed work ahead, or tree-pr opened no pull request; decide it: publish the branch by hand, amend the card or drop it`
}

export class AnswerExecutor {
  private readonly outcomes: AnswerOutcomes
  private readonly sources: AnswerSources
  private readonly publishing: AnswerPublishing
  private readonly questions: OwnerQuestions
  private readonly treesByAdmission = new Map<number, CardSession>()

  constructor(private readonly parts: AnswerParts) {
    const paths: CardPaths = { pathsIn, ownerBoundary: ownersEvenUnderTheDecision, wideningAsked: (question, scope, underAShard) => this.wideningInTheTree(question, scope, underAShard) }
    this.outcomes = new AnswerOutcomes(parts, paths)
    this.sources = new AnswerSources(parts)
    this.publishing = new AnswerPublishing(parts, this.outcomes)
    this.questions = new OwnerQuestions(parts, paths, this.outcomes, this.sources, this.publishing)
  }

  private wideningInTheTree(question: string, scope: AdmittedScope | null, underAShard: boolean): string[] {
    const asked = scopeWideningAsked(question, scope, underAShard)
    return scope === null || asked.length === 0 ? [] : changedInTheTreeOf(asked, this.changedIn(this.treesByAdmission.get(scope.admission)))
  }

  private ts(): string {
    return this.outcomes.ts()
  }

  async answer(lease: Lease): Promise<AnswerOutcome> {
    const leased = this.parts.clock().getTime()
    let admission: number | null = null
    try {
      assertHeld(this.parts.db, lease)
      if (answerOnAnOldCardBody(this.parts.db, lease))
        return this.outcomes.superseded(lease, `the body of card #${lease.cardId} was amended before this lease was taken; no session runs on the old body`)
      if (downgradeWaitOpenOn(this.parts.db, lease.cardId))
        return this.outcomes.denied(lease, { kind: 'technical', reason: DOWNGRADE_WAIT_OPEN, detail: `card #${lease.cardId} waits on the owner's witness downgrade decision; no answer round runs until that wait closes` })
      closeWaitOfAWidenStopTheAmendLifted(this.parts.db, () => this.ts(), lease.actor, lease.cardId)
      const owned = this.ownedCarriedTree(lease)
      if (owned !== null)
        return owned
      const stranded = lease.pr === null && lease.head !== null ? strandedAnswerOf(this.parts.db, lease.cardId, lease.head) : null
      if (stranded !== null)
        return this.republished(lease, stranded)
      const source = this.sources.sourceOf(lease)
      if (source === null && !this.sources.dirtyOnHead(lease))
        return this.outcomes.denied(lease, { kind: 'technical', reason: 'nothing_to_answer', detail: `card #${lease.cardId} has no open question.agent stop, no changes verdict, no red CI, no red witness and no conflict with ${MAIN_BRANCH} on ${lease.head ?? 'its head'}` })
      const hold = ownerHoldOf(this.parts.db, lease.cardId)
      if (hold !== null)
        return this.withdrawnUnderTheHold(lease, hold)
      const ratchet = source?.kind === 'question' ? this.ratchetGrowthAsked(lease, source.detail, []) : null
      if (ratchet !== null)
        return ratchet
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
      admission = admittedScopeOf(this.parts.db, lease.cardId)?.admission ?? null
      if (admission !== null)
        this.treesByAdmission.set(admission, card)
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
      const prove = findingsGivenByAReview(source)
      let answered = await this.session(lease, answering, widened, card, false, leased, prove)
      for (let restarts = 0; restartsAfter(answered) && restarts < ANSWER_RESTARTS; restarts += 1)
        answered = await this.session(lease, answering, widened, card, true, this.parts.clock().getTime(), prove)
      if ('kind' in answered)
        return this.refusedOrDenied(lease, answered, widened, card)
      const outside = this.stoppedOutsideTheTouches(lease, widened, card, answered)
      if (outside !== null)
        return outside
      if (restartsAfter(answered))
        return this.outcomes.stopped(lease, 'fault', `continuation-limit: card #${lease.cardId} answer session ${answered.session} stopped at the context warn; ${ANSWER_RESTARTS} of ${ANSWER_RESTARTS} continuations used (D-104), the card is not continued again and the bus pushed nothing from it`, { code: 'continuation-limit' }, widened === null ? [] : [widened.event])
      return await this.settled(lease, answering, widened, card, answered, minutesSince(sessionStart, this.parts.clock().getTime()), prove)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
    finally {
      if (admission !== null)
        this.treesByAdmission.delete(admission)
    }
  }

  private republished(lease: Lease, stranded: StrandedAnswer): AnswerOutcome {
    const card = this.tree(lease)
    if (card === null)
      return this.outcomes.denied(lease, { kind: 'technical', reason: 'no_card_tree', detail: `card #${lease.cardId} was answered at ${stranded.to} with no pull request, and has no tree to publish it from` })
    if ('kind' in card)
      return this.outcomes.denied(lease, card)
    const live = (this.parts.liveSession ?? liveSessionIn)(card)
    if (live !== null)
      return this.waitingForTheLiveSession(lease, live)
    if (this.dirty(card))
      return this.outcomes.denied(lease, { kind: 'technical', reason: 'nothing_to_answer', detail: strandedDirtyLine(lease.cardId, stranded, card) })
    const answered: Answered = { session: stranded.session, resumed: false, before: stranded.from, after: stranded.to, owner: null }
    return this.publishing.published(lease, REPUBLISHED, card, answered, 0, []) ?? this.outcomes.ownersStop(lease, strandedUnpublishedLine(lease.cardId, stranded, card))
  }

  private changedIn(card: CardSession | undefined): ReadonlySet<string> {
    if (card === undefined)
      return new Set()
    try {
      return new Set((this.parts.changedInTheTree ?? pendingPathsOf)(card))
    }
    catch {
      return new Set()
    }
  }

  private sessionStop(lease: Lease, widened: Widened | null, card: CardSession, answered: Answered): ReturnType<typeof sessionStopOf> {
    const outside = this.outsideTouchesOf(lease, widened)
    if (answered.owner === null || timeoutUnderLoadOutside(answered.owner, outside))
      return null
    return sessionStopOf([answered.owner], text => changedInTheTreeOf(outside(pathsIn(text)), this.changedIn(card)))
  }

  private stoppedOutsideTheTouches(lease: Lease, widened: Widened | null, card: CardSession, answered: Answered): AnswerOutcome | null {
    if (!endedOnContextWarn(answered))
      return null
    const stop = this.sessionStop(lease, widened, card, answered)
    if (stop?.code !== OUTSIDE_TOUCHES)
      return null
    const detail = `card #${lease.cardId} answer session ${answered.session} stopped at the context warn on ${stop.paths.join(', ')}, outside the touches the card was admitted with; no answer restart is spent and the card waits for intake to widen its touches: ${stop.blocker}`
    return this.outcomes.stopped(lease, QUESTION_AGENT, detail, { code: OUTSIDE_TOUCHES, blocker: stop.blocker, paths: stop.paths, widen: stop.paths }, widened === null ? [] : [widened.event])
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
    const merged = mergeMain(conflictingCardOf((cardId, files) => pathsOutsideTheBody(this.parts.db, cardId, files.join('\n')), lease.cardId, card.branch, lease.head))
    if (merged.kind === 'merged' && merged.to !== lease.head)
      console.log(`${PREFIX}card #${lease.cardId}: ${MAIN_BRANCH} merged into ${card.worktree} at ${merged.to} before the answer session`)
  }

  private waitingForTheLiveSession(lease: Lease, live: string): AnswerOutcome {
    const until = holdRecheckAt(this.parts.clock())
    console.log(`${PREFIX}card #${lease.cardId}: ${live}; the answer waits until ${until} and goes once that session ends`)
    waitTask(this.parts.db, this.parts.cards, this.ts(), lease, { reason: LIVE_SESSION_IN_THE_TREE, until })
    return { kind: 'waiting', taskKey: lease.taskKey, reason: LIVE_SESSION_IN_THE_TREE, until }
  }

  private waiting(lease: Lease, card: CardSession, why: string): AnswerOutcome {
    const detail = `pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head}, and the tree ${card.worktree} of card #${lease.cardId} cannot be read to answer it: ${why}`
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, [])
    const wait = openBusWait(this.parts.db, closedWaitIds(this.parts.db), this.ts(), lease.actor, { need: 'decision', text: detail, card: lease.cardId, ...(lease.pr === null ? {} : { pr: lease.pr }) })
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

  private async session(lease: Lease, source: AnswerSource, widened: Widened | null, card: CardSession, fresh: boolean, leased: number, prove: readonly string[]): Promise<Answered | AnswerDenial> {
    const preparing = this.parts.clock().getTime()
    const unprepared = prepareBeforeSession(card.worktree, this.parts.prepare ?? prepareTree)
    if (unprepared !== null)
      console.error(`${PREFIX}card #${lease.cardId}: ${unprepared}`)
    const prepared = this.parts.clock().getTime()
    const beforeTheSession = { lease: secondsOf(preparing - leased), tree: secondsOf(prepared - preparing) }
    this.recordSteps(lease, preparing, beforeTheSession)
    try {
      const answered = await this.parts.answerer({ lease, source, widened: widened?.reason ?? null, card, fresh, outsideTouches: this.outsideTouchesOf(lease, widened), allowances: this.parts.allowances?.(lease.cardId) ?? [], concept: this.conceptOf(lease), findingsToProve: prove, stepped: steps => this.recordSteps(lease, preparing, steps) })
      return answered.steps === undefined ? answered : { ...answered, steps: { ...beforeTheSession, ...answered.steps } }
    }
    catch (error) {
      return { kind: 'technical', reason: reasonOfFailure(error), detail: messageOf(error) }
    }
    finally {
      this.drainGateRuns(lease, card)
    }
  }

  private drainGateRuns(lease: Lease, card: CardSession): void {
    try {
      const drained = drainAnswerTreeGateRuns(this.parts.db, card.worktree)
      if (drained > 0)
        console.log(`${PREFIX}card #${lease.cardId}: ${drained} gate.run event${drained === 1 ? '' : 's'} the session kept in ${ANSWER_TREE_GATE_RUN_SPOOL} recorded on the bus`)
    }
    catch (error) {
      console.error(`${PREFIX}card #${lease.cardId}: the gate runs kept in ${ANSWER_TREE_GATE_RUN_SPOOL} stay there: ${messageOf(error)}`)
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

  private carriedState(card: CardSession, prHead: string): CarriedTree | null {
    return (this.parts.treeState ?? carriedTreeState)(card, prHead)
  }

  private returnedWithTheTree(lease: Lease, denial: AnswerDenial, card: CardSession): AnswerOutcome | null {
    const tree = denial.reason === 'answer_failed' && lease.head !== null ? this.carriedState(card, lease.head) : null
    if (tree === null || (tree.localCommits.length === 0 && !tree.dirty))
      return null
    const carried = `${denial.detail}; the tree ${tree.path} is returned at ${tree.head} with ${tree.localCommits.length} unpushed commit${tree.localCommits.length === 1 ? '' : 's'}${tree.dirty ? ' and uncommitted changes' : ''}, and the next answer on the card owns it`
    if (cutByRestart(this.parts.db, lease)) {
      releaseTask(this.parts.db, this.parts.cards, this.ts(), lease, RESTART_CUT, [], tree)
      return { kind: 'denied', taskKey: lease.taskKey, denial: { ...denial, detail: carried }, next: QUEUED }
    }
    const denialEvent: BusEvent = { ...this.outcomes.event(lease, POLICY_DENIED, { command: 'answer', ...denial, detail: carried }), actor: 'policy' }
    const next = failTask(this.parts.db, this.parts.cards, this.ts(), lease, { reason: denial.reason, withdraw: false, tree }, this.parts.silentMs, [denialEvent])
    return { kind: 'denied', taskKey: lease.taskKey, denial: { ...denial, detail: carried }, next }
  }

  private ownedCarriedTree(lease: Lease): AnswerOutcome | null {
    if (lease.head === null || carriedTreeOf(this.parts.db, lease.cardId) === null)
      return null
    const card = this.tree(lease)
    if (card === null || 'kind' in card || (this.parts.liveSession ?? liveSessionIn)(card) !== null)
      return null
    let owned: TreeOwned
    try {
      owned = (this.parts.ownTree ?? ownCarriedTree)(card, lease.head, this.parts.pushPolicy?.(card) ?? KEPT_WITHOUT_A_KNOWN_POLICY)
    }
    catch (error) {
      console.error(`${PREFIX}card #${lease.cardId}: the returned tree is not owned: ${messageOf(error)}`)
      return null
    }
    console.log(`${PREFIX}card #${lease.cardId}: the answer owns the returned tree ${card.worktree}: ${owned.kind} at ${owned.head}`)
    if (owned.kind !== 'pushed')
      return null
    const payload = { session: card.session, worktree: card.worktree, source: CARRIED_TREE, from: lease.head, to: owned.head }
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, [this.outcomes.event(lease, CARD_ANSWERED, payload)])
    return { kind: 'answered', taskKey: lease.taskKey, session: card.session, resumed: false, head: owned.head }
  }

  private refusedOrDenied(lease: Lease, denial: AnswerDenial, widened: Widened | null, card?: CardSession): AnswerOutcome {
    const returned = card === undefined ? null : this.returnedWithTheTree(lease, denial, card)
    if (returned !== null)
      return returned
    if (denial.reason !== 'outside_touches')
      return this.outcomes.denied(lease, denial)
    return this.outcomes.ownersStop(lease, `${denial.detail}; ${derivedRefusalNote(pathsIn(denial.detail))}the refused changes stay uncommitted in the card tree until the touches are widened or the changes are dropped`, widened === null ? [] : [widened.event], undefined, this.refusedPathsToWiden(denial.detail))
  }

  private refusedPathsToWiden(refusal: string): string[] {
    const refused = pathsIn(refusal)
    return this.outcomes.namesAnOwnerPath(refused) ? [] : refused.filter(file => !isRegisteredDerived(file))
  }

  private leftWorkWithoutAGate(card: CardSession, answered: Answered): boolean {
    if (answered.owner !== null || answered.gateDecision !== null || !leftNoNewHead(answered))
      return false
    const local = (this.parts.localHead ?? localHead)(card)
    return this.dirty(card) || (local !== null && local !== answered.before)
  }

  private dirty(card: CardSession): boolean {
    return (this.parts.dirty ?? treeDirtyOf)(card)
  }

  private async settled(lease: Lease, source: Answering, widened: Widened | null, card: CardSession, answered: Answered, minutes: number, prove: readonly string[]): Promise<AnswerOutcome> {
    const unproved = answered.owner === null ? unprovedFindings(prove, answered.proofs) : []
    if (unproved.length > 0)
      return this.outcomes.denied(lease, { kind: 'technical', reason: 'answer_failed', detail: unprovedFindingsLine(lease.cardId, answered, unproved) })
    if (this.leftWorkWithoutAGate(card, answered))
      return this.outcomes.denied(lease, { kind: 'technical', reason: 'answer_failed', detail: noGateDecisionLine(lease.cardId, answered) })
    const scope = [...(widened === null ? [] : [widened.event]), ...this.widenedInConcept(lease, answered)]
    if (answered.after === null || answered.after === answered.before) {
      if (answered.owner !== null && answered.noViolationFreePath === true)
        return this.outcomes.ownersStop(lease, answered.owner, scope)
      if (answered.owner !== null && !timeoutUnderLoadOutside(answered.owner, this.outsideTouchesOf(lease, widened)))
        return this.questions.staleQuestion(lease, answered.owner) ?? this.ratchetGrowthAsked(lease, answered.owner, scope) ?? this.askedTwiceInARow(lease, source, answered.owner, scope) ?? await this.questions.asked(lease, answered.owner, widened, card, this.decidedRound(lease, widened, card, prove))
      if (this.dirty(card))
        return this.publishing.leftDirty(lease, card, answered.session)
      return this.publishing.published(lease, source, card, answered, minutes, scope) ?? this.publishing.leftNothing(lease, answered, scope)
    }
    const published = this.dirty(card) ? null : this.publishing.published(lease, source, card, answered, minutes, scope)
    if (published !== null)
      return published
    const reentry = REENTRY_SOURCES.has(source.kind) || source.reentry === true
    const payload = this.publishing.answeredPayload(source, card, answered, minutes, reentry ? { reentry: true } : {})
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, [...scope, this.outcomes.event(lease, CARD_ANSWERED, payload)])
    return { kind: 'answered', taskKey: lease.taskKey, session: answered.session, resumed: answered.resumed, head: answered.after }
  }

  private ratchetGrowthAsked(lease: Lease, question: string, scope: BusEvent[]): AnswerOutcome | null {
    const rows = ratchetRowsAskedToGrow(question)
    if (rows.length === 0 || decisionAnsweringRepeat(this.parts.db, lease.cardId, question, this.parts.clock()) !== null)
      return null
    return this.outcomes.ownersStopOnce(lease, question, ratchetGrowthLine(lease.cardId, rows, question), rows, scope)
  }

  private askedTwiceInARow(lease: Lease, source: Answering, question: string, scope: BusEvent[]): AnswerOutcome | null {
    if (source.kind !== 'question' || source.detail.trim() !== question.trim())
      return null
    if (decisionAnsweringRepeat(this.parts.db, lease.cardId, question, this.parts.clock()) !== null)
      return null
    return this.outcomes.ownersStop(lease, question, scope, questionAskedTwiceLine(lease.cardId, question))
  }

  private decidedRound(lease: Lease, widened: Widened | null, card: CardSession, prove: readonly string[]): DecidedRound {
    return {
      run: async source => this.session(lease, source, widened, card, false, this.parts.clock().getTime(), prove),
      refusedOrDenied: denial => this.refusedOrDenied(lease, denial, widened),
      settled: async (source, answered) => this.settled(lease, source, widened, card, answered, 0, prove),
      dirty: () => this.dirty(card),
    }
  }
}

function answersQueuedAfterALateRelease(db: DatabaseSync, ts: string, cardId: number): string[] {
  const release = latestReleaseOf(db, cardId)
  if (release === null || ownerHoldOf(db, cardId) !== null)
    return []
  const missed = answersWithdrawnByAClosedHold(db, cardId, release.id)
  missed.forEach(task => queueAgain(db, ts, task, release.request, `${CARD_RELEASED}-${release.id}`))
  return missed.map(task => task.task_key)
}

export function closeWaitOfAWidenStopTheAmendLifted(db: DatabaseSync, ts: () => string, actor: string, cardId: number): string[] {
  const stop = latestWidenStopOf(db, cardId)
  const scope = admittedScopeOf(db, cardId)
  if (stop === null || scope === null || scope.admission <= stop.id)
    return []
  if (pathsOutside(scope.touches, scope.creates, stop.widen).length > 0)
    return []
  const asked = `card #${cardId} asks: ${String(stop.detail)}`
  const waits = openDecisionWaitsOfCard(db, cardId).filter(wait => wait.text === asked)
  for (const wait of waits)
    appendEvent(db, { ts: ts(), type: OWNER_WAIT_CLOSED, actor, cardId, pr: null, head: null, dedupeKey: `${OWNER_WAIT_CLOSED}:${wait.id}:widened-${stop.id}`, payload: { id: wait.id, answer: `the amend admitted as event ${scope.admission} covers ${stop.widen.join(', ')}, the paths stop ${stop.id} refused` }, legacy: false })
  return waits.map(wait => wait.id)
}

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
  const task = latestAnswerOf(db, cardId)
  if (task === null)
    return `the stop ${stop.id} is settled and card #${cardId} has no answer task to resume: it waits for the bus to derive one from its pull request, or for the window's takeover`
  return task.state === QUEUED || task.state === LEASED ? `the answer ${task.task_key} is ${task.state} already` : task
}
