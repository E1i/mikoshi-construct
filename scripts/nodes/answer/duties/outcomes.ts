import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../../core/db.js'
import type { EventPayload } from '../../../core/events.js'
import type { AfterFailure, Lease } from '../../../core/lease.js'
import type { WaitStep } from '../../../core/node.js'
import type { AdmittedScope } from '../answer-source.js'
import { openBusWait } from '../../../core/db.js'
import { CARD_STOPPED, POLICY_DENIED, QUESTION_OWNER } from '../../../core/events.js'
import { completeTask, failTask, supersedeLease, waitTask } from '../../../core/lease.js'
import { DOWNGRADE_WAIT_OPEN, supersededAnswerWithinItsLease } from '../../../core/queue.js'
import { cardDecisionCommand, decisionsInForceAt, unspentShard } from '../../../policy/shards.js'
import { TICK_MS } from '../../../ports/netwatch.js'
import { admittedScopeOf } from '../answer-source.js'
import { namesAnOwnerPath } from './stale-question.js'

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

export interface Widened {
  event: BusEvent
  reason: string
  paths: string[]
}

export interface OutcomeParts {
  db: DatabaseSync
  clock: () => Date
  ownerMerges: () => string
}

export interface CardPaths {
  pathsIn: (text: string) => string[]
  ownerBoundary: (paths: readonly string[]) => string | undefined
  wideningAsked: (question: string, scope: AdmittedScope | null, underAShard: boolean) => string[]
}

const SUPERSEDED_SESSION_ENDING = 'superseded_session_ending'

const WITHDRAWN_REASONS: ReadonlySet<AnswerTechnicalReason> = new Set(['nothing_to_answer', 'card_tree_gone', 'held_for_owner', DOWNGRADE_WAIT_OPEN])

export class AnswerOutcomes {
  constructor(private readonly parts: OutcomeParts, private readonly paths: CardPaths) {}

  ts(): string {
    return this.parts.clock().toISOString()
  }

  event(lease: Lease, type: string, payload: object): BusEvent {
    return { ts: this.ts(), type, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${type}:${lease.taskKey}:${lease.leaseGen}`, payload, legacy: false }
  }

  namesAnOwnerPath(named: readonly string[]): boolean {
    return namesAnOwnerPath(this.parts.ownerMerges(), named, this.paths.ownerBoundary)
  }

  stopped(lease: Lease, reason: string, detail: string, extra: EventPayload<typeof CARD_STOPPED> = {}, scope: BusEvent[] = [], inTheSameCommit: (db: DatabaseSync) => void = () => {}): AnswerOutcome {
    completeTask(this.parts.db, this.ts(), lease, [...scope, this.event(lease, CARD_STOPPED, { reason, detail, ...extra })], inTheSameCommit)
    return { kind: 'stopped', taskKey: lease.taskKey, reason, detail }
  }

  ownersStop(lease: Lease, detail: string, scope: BusEvent[] = [], text = `card #${lease.cardId} asks: ${detail}`, widen = this.windowWidens(lease, detail)): AnswerOutcome {
    const ask = { need: 'decision' as const, text, command: cardDecisionCommand(lease.cardId), card: lease.cardId, ...(lease.pr === null ? {} : { pr: lease.pr }) }
    return this.stopped(lease, QUESTION_OWNER, detail, widen.length === 0 ? {} : { widen }, scope, db => openBusWait(db, this.ts(), lease.actor, ask))
  }

  private windowWidens(lease: Lease, question: string): string[] {
    if (this.namesAnOwnerPath(this.paths.pathsIn(question)))
      return []
    const shard = unspentShard(this.parts.db, lease.cardId, lease.pr, decisionsInForceAt(this.parts.db, this.parts.clock()))
    return this.paths.wideningAsked(question, admittedScopeOf(this.parts.db, lease.cardId), shard !== null)
  }

  private denialEvent(lease: Lease, denial: AnswerDenial): BusEvent {
    return { ...this.event(lease, POLICY_DENIED, { command: 'answer', ...denial }), actor: 'policy' }
  }

  denied(lease: Lease, denial: AnswerDenial): AnswerOutcome {
    const next = failTask(this.parts.db, this.ts(), lease, { reason: denial.reason, withdraw: WITHDRAWN_REASONS.has(denial.reason) }, [this.denialEvent(lease, denial)])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }

  superseded(lease: Lease, detail: string): AnswerOutcome {
    const denial: AnswerDenial = { kind: 'technical', reason: 'old_card_body', detail }
    return { kind: 'denied', taskKey: lease.taskKey, denial, next: supersedeLease(this.parts.db, this.ts(), lease, [this.denialEvent(lease, denial)]) }
  }

  heldForTheOwner(lease: Lease, detail: string): AnswerOutcome {
    return this.denied(lease, { kind: 'technical', reason: 'held_for_owner', detail: `${detail}; the answer node takes no card the owner holds` })
  }

  waitingForTheSupersededSession(lease: Lease): AnswerOutcome | null {
    if (!supersededAnswerWithinItsLease(this.parts.db, lease.cardId, this.ts()))
      return null
    const until = new Date(this.parts.clock().getTime() + TICK_MS).toISOString()
    waitTask(this.parts.db, this.ts(), lease, { reason: SUPERSEDED_SESSION_ENDING, until })
    return { kind: 'waiting', taskKey: lease.taskKey, reason: SUPERSEDED_SESSION_ENDING, until }
  }
}
