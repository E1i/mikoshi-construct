import type { DatabaseSync } from 'node:sqlite'
import type { Isolation, IsolationReader } from '../ghosts/isolation.js'
import type { BusEvent } from './db.js'
import type { DiskReader } from './disk.js'
import type { Contour } from './launch-candidates.js'
import type { AfterFailure, Lease } from './lease.js'
import { NO_ISOLATION } from '../ghosts/isolation.js'
import { DISK_LOW, diskLowDetail, statfsReader } from './disk.js'
import { CARD_STARTED, POLICY_DENIED } from './inbox.js'
import { launchableCard } from './launch-candidates.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from './lease.js'

export type LaunchTechnicalReason = 'card_not_queued' | 'card_unreadable' | 'start_failed' | 'not_detached' | 'ladder_running' | 'ladder_fault' | typeof DISK_LOW | typeof NO_ISOLATION

export interface LaunchDenial {
  kind: 'technical'
  reason: LaunchTechnicalReason
  detail: string
}

export interface LaunchedCard {
  session: string
  worktree: string
  branch: string
  base: string
  pid: number
  pgid: number
  step?: string
}

export interface StartedCard extends LaunchedCard {
  contour: Contour
}

export type CardStart = { kind: 'started', card: LaunchedCard } | { kind: 'refused', denial: LaunchDenial }

export interface QueuedCard {
  cardId: number
  lane: string
}

export interface CardStarter {
  start: (card: QueuedCard) => CardStart
  stop: (card: StartedCard) => void
}

export type LaunchOutcome
  = | { kind: 'started', taskKey: string, card: StartedCard }
    | { kind: 'denied', taskKey: string, denial: LaunchDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface LaunchParts {
  db: DatabaseSync
  starter: CardStarter
  ladder?: CardStarter
  clock: () => Date
  disk?: DiskReader
  isolation: IsolationReader
}

const WITHDRAW_REASONS: ReadonlySet<LaunchTechnicalReason> = new Set(['card_not_queued'])

const RELEASE_REASONS: ReadonlySet<LaunchTechnicalReason> = new Set([DISK_LOW, NO_ISOLATION])

export function technical(reason: LaunchTechnicalReason, detail: string): LaunchDenial {
  return { kind: 'technical', reason, detail }
}

export class LaunchExecutor {
  private readonly disk: DiskReader

  constructor(private readonly parts: LaunchParts) {
    this.disk = parts.disk ?? statfsReader()
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  launch(lease: Lease): LaunchOutcome {
    try {
      assertHeld(this.parts.db, lease)
      const launchable = launchableCard(this.parts.db, lease.cardId)
      if (launchable === null)
        return this.denied(lease, technical('card_not_queued', `card #${lease.cardId} is no longer queued`))
      const diskLow = diskLowDetail(this.disk)
      if (diskLow !== null)
        return this.denied(lease, technical(DISK_LOW, `card #${lease.cardId} is not started: ${diskLow}`))
      const isolation = this.parts.isolation()
      if (isolation.level === 'none')
        return this.denied(lease, technical(NO_ISOLATION, `card #${lease.cardId} is not started: ${isolation.why}`))
      const starter = this.starterOf(launchable.contour)
      const start = starter.start({ cardId: lease.cardId, lane: launchable.lane })
      if (start.kind === 'refused')
        return this.denied(lease, start.denial)
      const card: StartedCard = { ...start.card, contour: launchable.contour }
      if (card.pgid !== card.pid) {
        starter.stop(card)
        return this.denied(lease, technical('not_detached', `card #${lease.cardId} runs as pid ${card.pid} in process group ${card.pgid}, not as its own group leader; it was stopped`))
      }
      return this.started(lease, card, starter, isolation)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private starterOf(contour: Contour): CardStarter {
    if (contour === 'cheap')
      return this.parts.starter
    return this.parts.ladder ?? { start: () => ({ kind: 'refused', denial: technical('start_failed', 'no ladder starter is wired into this launch node') }), stop: () => {} }
  }

  private started(lease: Lease, card: StartedCard, starter: CardStarter, isolation: Exclude<Isolation, { level: 'none' }>): LaunchOutcome {
    const event: BusEvent = { ts: this.ts(), type: CARD_STARTED, actor: lease.actor, cardId: lease.cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${lease.taskKey}`, payload: { ...card, isolation: isolation.level, isolationGaps: isolation.gaps }, legacy: false }
    try {
      completeTask(this.parts.db, this.ts(), lease, [event], (db) => {
        if (launchableCard(db, lease.cardId) === null)
          throw new StaleLease(`task ${lease.taskKey} is no longer due`)
      })
    }
    catch (error) {
      starter.stop(card)
      throw error
    }
    return { kind: 'started', taskKey: lease.taskKey, card }
  }

  private denied(lease: Lease, denial: LaunchDenial): LaunchOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: null, head: null, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'launch', ...denial }, legacy: false }
    if (RELEASE_REASONS.has(denial.reason)) {
      releaseTask(this.parts.db, ts, lease, denial.reason, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: 'queued' }
    }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: WITHDRAW_REASONS.has(denial.reason) }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}
