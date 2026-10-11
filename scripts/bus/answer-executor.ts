import type { DatabaseSync } from 'node:sqlite'
import type { AnswerSource, CardSession } from './answer-source.js'
import type { Answered, Answerer } from './answerer.js'
import type { CardTreeTools } from './card-tree.js'
import type { BusEvent } from './db.js'
import type { AfterFailure, Lease } from './lease.js'
import { answerSourceOf } from './answer-source.js'
import { CardTreeGone } from './answerer.js'
import { cardTreeOf, realCardTrees } from './card-tree.js'
import { messageOf } from './executor.js'
import { CARD_ANSWERED, CARD_STOPPED, POLICY_DENIED } from './inbox.js'
import { assertHeld, completeTask, failTask, StaleLease } from './lease.js'
import { QUESTION_OWNER } from './queue.js'
import { wideningOf } from './widening.js'

export const SCOPE_WIDENED = 'scope.widened'

export type AnswerTechnicalReason = 'nothing_to_answer' | 'no_card_tree' | 'card_tree_gone' | 'answer_failed'

export interface AnswerDenial {
  kind: 'technical'
  reason: AnswerTechnicalReason
  detail: string
}

export type AnswerOutcome
  = | { kind: 'answered', taskKey: string, session: string, resumed: boolean, head: string }
    | { kind: 'stopped', taskKey: string, reason: string, detail: string }
    | { kind: 'denied', taskKey: string, denial: AnswerDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface AnswerParts {
  db: DatabaseSync
  answerer: Answerer
  ownerMerges: () => string
  clock: () => Date
  trees?: CardTreeTools
}

interface Widened {
  event: BusEvent
  reason: string
}

const WITHDRAWN_REASONS: ReadonlySet<AnswerTechnicalReason> = new Set(['nothing_to_answer', 'card_tree_gone'])

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
      const source = answerSourceOf(this.parts.db, lease)
      if (source === null)
        return this.denied(lease, { kind: 'technical', reason: 'nothing_to_answer', detail: `card #${lease.cardId} has no open question.agent stop, no changes verdict and no red CI on ${lease.head ?? 'its head'}` })
      let widened: Widened | null = null
      if (source.kind === 'question' && source.widen !== null) {
        const widening = wideningOf(source.widen.paths, source.widen.touches, this.parts.ownerMerges())
        if (widening.kind === 'owner')
          return this.stopped(lease, QUESTION_OWNER, `${widening.reason}: ${source.detail}`)
        widened = { reason: widening.reason, event: this.event(lease, SCOPE_WIDENED, { paths: widening.paths, touches: source.widen.touches, reason: widening.reason, detail: source.detail }) }
      }
      const card = this.tree(lease)
      if (card === null)
        return this.denied(lease, { kind: 'technical', reason: 'no_card_tree', detail: `card #${lease.cardId} has no card.started, no start line with a worktree and a branch, and no open pull request` })
      if ('kind' in card)
        return this.denied(lease, card)
      const answered = await this.session(lease, source, widened, card)
      if ('kind' in answered)
        return this.denied(lease, answered)
      return this.settled(lease, source, widened, answered)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private tree(lease: Lease): CardSession | AnswerDenial | null {
    try {
      return cardTreeOf(this.parts.db, lease.cardId, this.parts.trees ?? realCardTrees())
    }
    catch (error) {
      return { kind: 'technical', reason: 'answer_failed', detail: `the tree of card #${lease.cardId} could not be recreated: ${messageOf(error)}` }
    }
  }

  private async session(lease: Lease, source: AnswerSource, widened: Widened | null, card: CardSession): Promise<Answered | AnswerDenial> {
    try {
      return await this.parts.answerer({ lease, source, widened: widened?.reason ?? null, card })
    }
    catch (error) {
      return { kind: 'technical', reason: error instanceof CardTreeGone ? 'card_tree_gone' : 'answer_failed', detail: messageOf(error) }
    }
  }

  private settled(lease: Lease, source: AnswerSource, widened: Widened | null, answered: Answered): AnswerOutcome {
    const scope = widened === null ? [] : [widened.event]
    if (answered.after === null || answered.after === answered.before) {
      if (answered.owner !== null)
        return this.stopped(lease, QUESTION_OWNER, answered.owner, scope)
      const detail = `the answer session ${answered.session} left ${lease.taskKey} at ${answered.after ?? 'no pushed head'}`
      return this.stopped(lease, 'fault', detail, scope)
    }
    const payload = { session: answered.session, resumed: answered.resumed, source: source.kind, from: answered.before, to: answered.after }
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_ANSWERED, payload)])
    return { kind: 'answered', taskKey: lease.taskKey, session: answered.session, resumed: answered.resumed, head: answered.after }
  }

  private stopped(lease: Lease, reason: string, detail: string, scope: BusEvent[] = []): AnswerOutcome {
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_STOPPED, { reason, detail })])
    return { kind: 'stopped', taskKey: lease.taskKey, reason, detail }
  }

  private denied(lease: Lease, denial: AnswerDenial): AnswerOutcome {
    const event: BusEvent = { ...this.event(lease, POLICY_DENIED, { command: 'answer', ...denial }), actor: 'policy' }
    const next = failTask(this.parts.db, this.ts(), lease, { reason: denial.reason, withdraw: WITHDRAWN_REASONS.has(denial.reason) }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}
