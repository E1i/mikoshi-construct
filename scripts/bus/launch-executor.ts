import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { AfterFailure, Lease } from './lease.js'
import { POLICY_DENIED } from './inbox.js'
import { CARD_STARTED, queuedLane } from './launch-candidates.js'
import { assertHeld, completeTask, failTask, StaleLease } from './lease.js'

export type LaunchTechnicalReason = 'card_not_queued' | 'no_shift_mode' | 'card_unreadable' | 'start_failed' | 'not_detached'

export interface LaunchDenial {
  kind: 'technical'
  reason: LaunchTechnicalReason
  detail: string
}

export interface StartedCard {
  session: string
  worktree: string
  branch: string
  base: string
  pid: number
  pgid: number
}

export type CardStart = { kind: 'started', card: StartedCard } | { kind: 'refused', denial: LaunchDenial }

export interface QueuedCard {
  cardId: number
  lane: string
}

export interface CardStarter {
  start: (card: QueuedCard) => CardStart
}

export type LaunchOutcome
  = | { kind: 'started', taskKey: string, card: StartedCard }
    | { kind: 'denied', taskKey: string, denial: LaunchDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface LaunchParts {
  db: DatabaseSync
  starter: CardStarter
  clock: () => Date
}

const WITHDRAW_REASONS: ReadonlySet<LaunchTechnicalReason> = new Set(['card_not_queued'])

export function technical(reason: LaunchTechnicalReason, detail: string): LaunchDenial {
  return { kind: 'technical', reason, detail }
}

export class LaunchExecutor {
  constructor(private readonly parts: LaunchParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  launch(lease: Lease): LaunchOutcome {
    try {
      assertHeld(this.parts.db, lease)
      const lane = queuedLane(this.parts.db, lease.cardId)
      if (lane === null)
        return this.denied(lease, technical('card_not_queued', `card #${lease.cardId} is no longer queued`))
      const start = this.parts.starter.start({ cardId: lease.cardId, lane })
      if (start.kind === 'refused')
        return this.denied(lease, start.denial)
      if (start.card.pgid !== start.card.pid)
        return this.denied(lease, technical('not_detached', `card #${lease.cardId} runs as pid ${start.card.pid} in process group ${start.card.pgid}, not as its own group leader`))
      return this.started(lease, start.card)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private started(lease: Lease, card: StartedCard): LaunchOutcome {
    const event: BusEvent = { ts: this.ts(), type: CARD_STARTED, actor: lease.actor, cardId: lease.cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${lease.taskKey}`, payload: { ...card }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [event], () => queuedLane(this.parts.db, lease.cardId) !== null)
    return { kind: 'started', taskKey: lease.taskKey, card }
  }

  private denied(lease: Lease, denial: LaunchDenial): LaunchOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: null, head: null, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'launch', ...denial }, legacy: false }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: WITHDRAW_REASONS.has(denial.reason) }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}
