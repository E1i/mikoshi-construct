import type { DatabaseSync } from 'node:sqlite'
import type { Isolation, IsolationReader } from '../ghosts/isolation.js'
import type { BusEvent } from './db.js'
import type { DiskReader } from './disk.js'
import type { Contour, TreeReader } from './launch-candidates.js'
import type { AfterFailure, Lease } from './lease.js'
import type { SessionInput } from './prompt-store.js'
import { existsSync } from 'node:fs'
import { CARD_STARTED, CARD_STOPPED, POLICY_DENIED } from '../core/events.js'
import { NO_ISOLATION } from '../ghosts/isolation.js'
import { DISK_LOW, diskLowDetail, statfsReader } from './disk.js'
import { launchableCard } from './launch-candidates.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from './lease.js'
import { storedInput } from './prompt-store.js'

export const HELD_TREE_CHANGED = 'held_tree_changed'

export type LaunchTechnicalReason = 'card_not_queued' | 'card_unreadable' | 'start_failed' | 'not_detached' | 'ladder_running' | 'ladder_fault' | typeof HELD_TREE_CHANGED | typeof DISK_LOW | typeof NO_ISOLATION

export interface LaunchDenial {
  kind: 'technical'
  reason: LaunchTechnicalReason
  detail: string
  paths?: string[]
}

export interface LaunchedCard {
  session: string
  worktree: string
  branch: string
  base: string
  pid: number
  pgid: number
  step?: string
  input?: SessionInput
}

export interface StartedCard extends LaunchedCard {
  contour: Contour
}

export type CardStart = { kind: 'started', card: LaunchedCard } | { kind: 'refused', denial: LaunchDenial }

export interface HeldTree {
  worktree: string
  base: string | null
}

export interface QueuedCard {
  cardId: number
  lane: string
  continueIn?: HeldTree
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
  prompts?: string
  treeLive?: TreeReader
}

const WITHDRAW_REASONS: ReadonlySet<LaunchTechnicalReason> = new Set(['card_not_queued', HELD_TREE_CHANGED])

const HELD_TREE = `
  SELECT json_extract(payload, '$.worktree') AS worktree, json_extract(payload, '$.base') AS base FROM events
  WHERE legacy = 0 AND type = '${CARD_STARTED}' AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.worktree') = 'text'
  ORDER BY id DESC LIMIT 1
`

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
      const start = starter.start({ cardId: lease.cardId, lane: launchable.lane, ...this.heldTreeOf(lease.cardId, launchable.contour) })
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

  private heldTreeOf(cardId: number, contour: Contour): { continueIn?: HeldTree } {
    if (contour !== 'cheap')
      return {}
    const row = this.parts.db.prepare(HELD_TREE).get(cardId) as { worktree: string, base: unknown } | undefined
    if (row === undefined || !(this.parts.treeLive ?? existsSync)(row.worktree))
      return {}
    return { continueIn: { worktree: row.worktree, base: typeof row.base === 'string' ? row.base : null } }
  }

  private starterOf(contour: Contour): CardStarter {
    if (contour === 'cheap')
      return this.parts.starter
    return this.parts.ladder ?? { start: () => ({ kind: 'refused', denial: technical('start_failed', 'no ladder starter is wired into this launch node') }), stop: () => {} }
  }

  private started(lease: Lease, card: StartedCard, starter: CardStarter, isolation: Exclude<Isolation, { level: 'none' }>): LaunchOutcome {
    const { input, ...started } = card
    const payload = { ...started, isolation: isolation.level, isolationGaps: isolation.gaps, ...storedInput(this.parts.prompts, input) }
    const event: BusEvent = { ts: this.ts(), type: CARD_STARTED, actor: lease.actor, cardId: lease.cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${lease.taskKey}`, payload, legacy: false }
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
    const stopped: BusEvent[] = denial.reason === HELD_TREE_CHANGED
      ? [{ ts, type: CARD_STOPPED, actor: lease.actor, cardId: lease.cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${HELD_TREE_CHANGED}:${lease.taskKey}`, payload: { reason: 'fault', detail: `${HELD_TREE_CHANGED}: ${denial.detail}`, paths: denial.paths ?? [] }, legacy: false }]
      : []
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: WITHDRAW_REASONS.has(denial.reason) }, [event, ...stopped])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}
