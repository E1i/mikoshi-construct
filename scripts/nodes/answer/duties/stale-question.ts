import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import type { Isolation, IsolationReader } from '../../../ports/isolation.js'
import type { AnswerSource, CardSession } from '../answer-source.js'
import type { Answered } from '../answerer.js'
import type { AnswerDenial, AnswerOutcome, AnswerOutcomes, CardPaths, Widened } from './outcomes.js'
import type { AnswerPublishing } from './publishing.js'
import type { Answering, AnswerSources } from './source.js'
import { CLOSED_WAIT, OWNER_WAITS } from '../../../core/bus-readings.js'
import { appendEvent } from '../../../core/db.js'
import { QUESTION_AGENT, QUESTION_OWNER, SHARD_DECIDED } from '../../../core/events.js'
import { assertHeld, completeTask } from '../../../core/lease.js'
import { answerOnAnOldCardBody, downgradeWaitOpenOn } from '../../../core/queue.js'
import { OWNER_EVEN_UNDER_THE_DECISION, reservationOf } from '../../../policy/policy.js'
import { activeDecisionsShard, DECISIONS_SCOPE, decisionsInForceAt, ownersUnderAnyShard, unspentShard } from '../../../policy/shards.js'
import { matchGlob } from '../../../policy/shredder/glob.js'
import { ownerGlobs } from '../../../policy/widening.js'
import { decisionAnsweringRepeat } from '../answer-source.js'

export interface ShardDecision {
  answer: string
  doneBy?: string
}

export type ShardDecider = (lease: Lease, question: string) => ShardDecision | null

export interface QuestionParts {
  db: DatabaseSync
  clock: () => Date
  ownerMerges: () => string
  shardDecider?: ShardDecider
  isolation?: IsolationReader
}

export interface DecidedRound {
  run: (source: AnswerSource) => Promise<Answered | AnswerDenial>
  refusedOrDenied: (denial: AnswerDenial) => AnswerOutcome
  settled: (source: Answering, answered: Answered) => Promise<AnswerOutcome>
  dirty: () => boolean
}

const DECISION_OPTIONS = [`${QUESTION_OWNER}: stop the card for the owner`, `${SHARD_DECIDED}: the window decides and the card goes on`]

const NAMES_A_WAIT = /\b[QW]\d+\b/g

const IS_A_CLOSED_WAIT = `SELECT 1 FROM ${OWNER_WAITS} WHERE id = ? AND state = '${CLOSED_WAIT}'`

export function namesAnOwnerPath(ownerMerges: string, named: readonly string[], ownerBoundary: CardPaths['ownerBoundary']): boolean {
  const globs = ownerGlobs(ownerMerges)
  return ownerBoundary(named) !== undefined || named.some(file => globs.some(glob => matchGlob(glob, file)))
}

function decisionSource(question: string, ground: string, decision: ShardDecision, decisions: string[]): AnswerSource {
  const whoActs = decision.doneBy === undefined ? '' : ` ${decision.doneBy} does it, not this session.`
  return { kind: 'question', detail: `your question went to the window, and the window decided it under ${ground}: ${decision.answer}.${whoActs} The card goes on without the owner. The question was: ${question}`, widen: null, events: [], decisions }
}

function heldForTheWindow(question: string, shard: string, why: string): string {
  return `${question} (held for the window under the ${DECISIONS_SCOPE} shard ${shard}: ${why}; the window closes the wait with its answer)`
}

export function leftNoNewHead(answered: Answered): boolean {
  return answered.after === null || answered.after === answered.before
}

export class OwnerQuestions {
  constructor(private readonly parts: QuestionParts, private readonly paths: CardPaths, private readonly outcomes: AnswerOutcomes, private readonly sources: AnswerSources, private readonly publishing: AnswerPublishing) {}

  staleQuestion(lease: Lease, question: string): AnswerOutcome | null {
    if (answerOnAnOldCardBody(this.parts.db, lease))
      return this.outcomes.superseded(lease, `the body of card #${lease.cardId} was amended while the answer session ran; no owner question is written, and the answer goes again on the new body. The question was: ${question}`)
    const closed = [...new Set(question.match(NAMES_A_WAIT) ?? [])].filter(id => this.parts.db.prepare(IS_A_CLOSED_WAIT).get(id) !== undefined)
    if (closed.length === 0)
      return null
    return this.outcomes.denied(lease, { kind: 'technical', reason: 'closed_wait', detail: `the answer session named ${closed.join(', ')}, already closed; no owner question is written, and the answer goes again with the closed waits of the card in its prompt. The question was: ${question}` })
  }

  async asked(lease: Lease, question: string, widened: Widened | null, card: CardSession, round: DecidedRound): Promise<AnswerOutcome> {
    const stale = this.staleQuestion(lease, question)
    if (stale !== null)
      return stale
    const answeredBy = decisionAnsweringRepeat(this.parts.db, lease.cardId, question, this.parts.clock())
    if (answeredBy !== null)
      return this.outcomes.denied(lease, { kind: 'technical', reason: 'repeated_stop', detail: `the answer session asked again what card #${lease.cardId} already stopped on, and D-${answeredBy} was recorded for the card after that stop; no new owner wait, the answer goes again with the decision in its prompt. The question was: ${question}` })
    const scope = widened === null ? [] : [widened.event]
    if (downgradeWaitOpenOn(this.parts.db, lease.cardId))
      return this.outcomes.ownersStop(lease, question, scope)
    if (!this.ownersQuestion(lease, question))
      return this.outcomes.stopped(lease, QUESTION_AGENT, question, {}, scope)
    const shard = activeDecisionsShard(this.parts.db, this.parts.clock())
    if (shard === null || reservationOf(lease.cardId, question))
      return this.outcomes.ownersStop(lease, question, scope)
    const reserved = ownersUnderAnyShard(question)
    if (reserved !== null)
      return this.outcomes.ownersStop(lease, `${question} (${reserved} stays the owner's under any shard)`, scope)
    const boundary = this.paths.ownerBoundary(this.paths.pathsIn(question))
    if (boundary !== undefined)
      return this.outcomes.ownersStop(lease, `${question} (${boundary} is ${OWNER_EVEN_UNDER_THE_DECISION} and stays the owner's under any shard)`, scope)
    const isolation: Isolation = this.parts.isolation?.() ?? { level: 'none', why: 'the answer worker reads no isolation' }
    if (isolation.level === 'none')
      return this.outcomes.ownersStop(lease, `${question} (the ${DECISIONS_SCOPE} shard ${shard.id} is refused without isolation: ${isolation.why})`, scope)
    const ground = `window shard ${shard.id} (${shard.scope}, by ${shard.by}, until ${shard.until}) under ${isolation.level} isolation`
    const decision = this.parts.shardDecider?.(lease, question) ?? null
    if (decision === null || decision.answer.trim() === '')
      return this.outcomes.ownersStop(lease, heldForTheWindow(question, shard.id, 'the bus has no decision text for it, and a shard decision without one is refused'), scope)
    assertHeld(this.parts.db, lease)
    appendEvent(this.parts.db, this.outcomes.event(lease, SHARD_DECIDED, { shard: shard.id, question, ground, options: DECISION_OPTIONS, answer: decision.answer, ...(decision.doneBy === undefined ? {} : { doneBy: decision.doneBy }) }))
    const decidedSource = decisionSource(question, ground, decision, this.sources.boundDecisions(lease))
    const decided = await round.run(decidedSource)
    if ('kind' in decided)
      return round.refusedOrDenied(decided)
    if (!leftNoNewHead(decided))
      return round.settled(decidedSource, decided)
    if (decided.owner !== null)
      return this.staleQuestion(lease, decided.owner) ?? this.outcomes.ownersStop(lease, heldForTheWindow(decided.owner, shard.id, `the session could not act on the decision of: ${question}`), scope)
    if (round.dirty())
      return this.publishing.leftDirty(lease, card, decided.session)
    completeTask(this.parts.db, this.outcomes.ts(), lease, scope)
    return { kind: 'decided', taskKey: lease.taskKey, shard: shard.id, question }
  }

  private ownersQuestion(lease: Lease, question: string): boolean {
    const decisions = decisionsInForceAt(this.parts.db, this.parts.clock())
    if ([question, ...decisions.map(decision => decision.text)].some(text => reservationOf(lease.cardId, text)))
      return true
    if (unspentShard(this.parts.db, lease.cardId, lease.pr, decisions) !== null)
      return false
    return this.outcomes.namesAnOwnerPath(this.paths.pathsIn(question))
  }
}
