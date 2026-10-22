import type { DatabaseSync } from 'node:sqlite'
import type { Isolation, IsolationReader } from '../ports/isolation.js'
import type { AnswerSource, CardSession } from './answer-source.js'
import type { Answered, Answerer } from './answerer.js'
import type { CardTreeTools } from './card-tree.js'
import type { BusEvent } from './db.js'
import type { AfterFailure, Lease } from './lease.js'
import type { AnswerInput } from './prompt-store.js'
import { withinTouches } from '../../src/card/covering-tests.js'
import { createdPaths } from '../../src/card/parking.js'
import { riskOf } from '../../src/card/risk.js'
import { CARD_ANSWERED, CARD_STOPPED, POLICY_DENIED, QUESTION_AGENT, QUESTION_OWNER, SCOPE_WIDENED, SHARD_DECIDED } from '../core/events.js'
import { matchGlob } from '../shredder/glob.js'
import { admittedScopeOf, answerSourceOf } from './answer-source.js'
import { CardTreeGone } from './answerer.js'
import { cardTreeOf, CardTreeRefused, realCardTrees } from './card-tree.js'
import { messageOf } from './errors.js'
import { assertHeld, completeTask, failTask, StaleLease } from './lease.js'
import { OWNER_EVEN_UNDER_THE_DECISION, reservationOf } from './policy.js'
import { sha256, storedInput } from './prompt-store.js'
import { activeDecisionsShard, DECISIONS_SCOPE, decisionsInForceAt, ownersUnderAnyShard, unspentShard } from './shards.js'
import { MAIN_BRANCH } from './snapshot.js'
import { ownerGlobs } from './widening.js'

export type AnswerTechnicalReason = 'nothing_to_answer' | 'no_card_tree' | 'card_tree_gone' | 'answer_failed'

export interface AnswerDenial {
  kind: 'technical'
  reason: AnswerTechnicalReason
  detail: string
}

export type AnswerOutcome
  = | { kind: 'answered', taskKey: string, session: string, resumed: boolean, head: string }
    | { kind: 'stopped', taskKey: string, reason: string, detail: string }
    | { kind: 'decided', taskKey: string, shard: string, question: string }
    | { kind: 'denied', taskKey: string, denial: AnswerDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface AnswerParts {
  db: DatabaseSync
  answerer: Answerer
  ownerMerges: () => string
  clock: () => Date
  trees?: CardTreeTools
  isolation?: IsolationReader
  prompts?: string
}

interface Widened {
  event: BusEvent
  reason: string
}

const DECISION_OPTIONS = [`${QUESTION_OWNER}: stop the card for the owner`, `${SHARD_DECIDED}: the window decides and the card goes on`]

const WORD_BOUNDARY = /[\s,;:()[\]"'`?!<>]+/
const TRAILING_DOTS = /\.+$/
const FILE_EXTENSION = /\.[a-z][\w-]*$/i

function pathsIn(question: string): string[] {
  return question.split(WORD_BOUNDARY).map(word => word.replace(TRAILING_DOTS, '')).filter(word => word.includes('/') || FILE_EXTENSION.test(word))
}

const DIRTY_ON_HEAD = `SELECT 1 FROM prs WHERE pr = ? AND head = ? AND state = 'open' AND mergeable = 'dirty'`

const WITHDRAWN_REASONS: ReadonlySet<AnswerTechnicalReason> = new Set(['nothing_to_answer', 'card_tree_gone'])

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

function leftNoNewHead(answered: Answered): boolean {
  return answered.after === null || answered.after === answered.before
}

function endedOnContextWarn(answered: Answered | AnswerDenial): answered is Answered {
  return !('kind' in answered) && answered.atContextWarn === true && answered.owner === null && leftNoNewHead(answered)
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
    try {
      assertHeld(this.parts.db, lease)
      const source = answerSourceOf(this.parts.db, lease) ?? this.conflict(lease)
      if (source === null)
        return this.denied(lease, { kind: 'technical', reason: 'nothing_to_answer', detail: `card #${lease.cardId} has no open question.agent stop, no changes verdict, no red CI and no conflict with ${MAIN_BRANCH} on ${lease.head ?? 'its head'}` })
      let widened: Widened | null = null
      if (source.kind === 'question' && source.widen !== null) {
        const globs = ownerGlobs(this.parts.ownerMerges())
        const ownerPath = source.widen.paths.find(file => globs.some(glob => matchGlob(glob, file)))
        if (ownerPath !== undefined)
          return this.stopped(lease, QUESTION_OWNER, `${ownerPath} is an owner path: ${source.detail}`)
        const scope = admittedScopeOf(this.parts.db, lease.cardId)
        const created = createdPaths(scope?.creates ?? [])
        const uncovered = source.widen.paths.filter(file => scope === null || !(withinTouches(file, scope.touches) || created.includes(file)))
        if (scope === null || uncovered.length > 0)
          return this.stopped(lease, QUESTION_AGENT, `${uncovered.join(', ')} not in the touches or creates the card was admitted with: ${source.detail}`, { widen: uncovered })
        const reason = `${source.widen.paths.join(', ')}, by the window's amend of the card`
        widened = { reason, event: this.event(lease, SCOPE_WIDENED, { paths: source.widen.paths, admission: scope.admission, detail: source.detail }) }
      }
      const card = this.tree(lease)
      if (card === null)
        return this.denied(lease, { kind: 'technical', reason: 'no_card_tree', detail: `card #${lease.cardId} has no card.started, no start line with a worktree and a branch, and no open pull request` })
      if ('kind' in card)
        return this.denied(lease, card)
      const sessionStart = this.parts.clock().getTime()
      const first = await this.session(lease, source, widened, card, false)
      const answered = endedOnContextWarn(first) ? await this.session(lease, source, widened, card, true) : first
      if ('kind' in answered)
        return this.denied(lease, answered)
      return this.settled(lease, source, widened, card, answered, minutesSince(sessionStart, this.parts.clock().getTime()))
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private conflict(lease: Lease): AnswerSource | null {
    if (lease.pr === null || lease.head === null || this.parts.db.prepare(DIRTY_ON_HEAD).get(lease.pr, lease.head) === undefined)
      return null
    return { kind: 'changes', findings: [`pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head}: merge origin/${MAIN_BRANCH} into the branch and resolve every conflict, keeping what the card asks for`], events: [] }
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

  private async session(lease: Lease, source: AnswerSource, widened: Widened | null, card: CardSession, fresh: boolean): Promise<Answered | AnswerDenial> {
    try {
      return await this.parts.answerer({ lease, source, widened: widened?.reason ?? null, card, fresh })
    }
    catch (error) {
      return { kind: 'technical', reason: error instanceof CardTreeGone ? 'card_tree_gone' : 'answer_failed', detail: messageOf(error) }
    }
  }

  private settled(lease: Lease, source: AnswerSource, widened: Widened | null, card: CardSession, answered: Answered, minutes: number): AnswerOutcome {
    const scope = widened === null ? [] : [widened.event]
    if (answered.after === null || answered.after === answered.before) {
      if (answered.owner !== null)
        return this.asked(lease, answered.owner, scope)
      const detail = `the answer session ${answered.session} left ${lease.taskKey} at ${answered.after ?? 'no pushed head'}`
      return this.stopped(lease, 'fault', detail, {}, scope)
    }
    const payload = { session: answered.session, worktree: card.worktree, resumed: answered.resumed, source: source.kind, from: answered.before, to: answered.after, ...measurementOf(answered, minutes), ...storedInput(this.parts.prompts, answered.input), ...cardBodyOf(answered.input) }
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_ANSWERED, payload)])
    return { kind: 'answered', taskKey: lease.taskKey, session: answered.session, resumed: answered.resumed, head: answered.after }
  }

  private asked(lease: Lease, question: string, scope: BusEvent[]): AnswerOutcome {
    if (!this.ownersQuestion(lease, question))
      return this.stopped(lease, QUESTION_AGENT, question, {}, scope)
    const shard = activeDecisionsShard(this.parts.db, this.parts.clock())
    if (shard === null || reservationOf(lease.cardId, question))
      return this.stopped(lease, QUESTION_OWNER, question, {}, scope)
    const reserved = ownersUnderAnyShard(question)
    if (reserved !== null)
      return this.stopped(lease, QUESTION_OWNER, `${question} (${reserved} stays the owner's under any shard)`, {}, scope)
    const isolation: Isolation = this.parts.isolation?.() ?? { level: 'none', why: 'the answer worker reads no isolation' }
    if (isolation.level === 'none')
      return this.stopped(lease, QUESTION_OWNER, `${question} (the ${DECISIONS_SCOPE} shard ${shard.id} is refused without isolation: ${isolation.why})`, {}, scope)
    const ground = `window shard ${shard.id} (${shard.scope}, by ${shard.by}, until ${shard.until}) under ${isolation.level} isolation`
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, SHARD_DECIDED, { shard: shard.id, question, ground, options: DECISION_OPTIONS })])
    return { kind: 'decided', taskKey: lease.taskKey, shard: shard.id, question }
  }

  private ownersQuestion(lease: Lease, question: string): boolean {
    const decisions = decisionsInForceAt(this.parts.db, this.parts.clock())
    if ([question, ...decisions.map(decision => decision.text)].some(text => reservationOf(lease.cardId, text)))
      return true
    if (unspentShard(this.parts.db, lease.cardId, lease.pr, decisions) !== null)
      return false
    const globs = ownerGlobs(this.parts.ownerMerges())
    return pathsIn(question).some(file => riskOf(file).level === OWNER_EVEN_UNDER_THE_DECISION || globs.some(glob => matchGlob(glob, file)))
  }

  private stopped(lease: Lease, reason: string, detail: string, extra: Record<string, unknown> = {}, scope: BusEvent[] = []): AnswerOutcome {
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_STOPPED, { reason, detail, ...extra })])
    return { kind: 'stopped', taskKey: lease.taskKey, reason, detail }
  }

  private denied(lease: Lease, denial: AnswerDenial): AnswerOutcome {
    const event: BusEvent = { ...this.event(lease, POLICY_DENIED, { command: 'answer', ...denial }), actor: 'policy' }
    const next = failTask(this.parts.db, this.ts(), lease, { reason: denial.reason, withdraw: WITHDRAWN_REASONS.has(denial.reason) }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}
