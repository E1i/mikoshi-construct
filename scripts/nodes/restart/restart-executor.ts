import type { DatabaseSync } from 'node:sqlite'
import type { ChainRow, ChainState } from '../../core/chain.js'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, CardTransitions, Lease } from '../../core/lease.js'
import type { ProcessTable } from './chain-process.js'
import type { Role } from './role.js'
import { CLOSED_CARD, DROPPED_CARD, RUNNING_CARD } from '../../core/card-automaton.js'
import { cardStatesAmong } from '../../core/card-readings.js'
import { chainOfCard, chainOfDir, observeChain } from '../../core/chain.js'
import { inTransaction } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { EITHER_JOURNAL, events } from '../../core/events-query.js'
import { CARD_STOPPED, CHAIN_OBSERVED, CHAIN_RESTARTED, POLICY_DENIED } from '../../core/events.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from '../../core/lease.js'
import { chainProcess, stopChain } from './chain-process.js'

export type RestartReason = 'no_chain' | 'chain_current' | 'chain_dead' | 'launch_off' | 'stop_failed'
export type RestartWait = 'not_at_boundary'

export type RestartOutcome
  = | { kind: 'handed', taskKey: string, dir: string, cardId: number, cardStopped: boolean }
    | { kind: 'waiting', taskKey: string, dir: string, why: RestartWait }
    | { kind: 'denied', taskKey: string, reason: RestartReason, detail: string, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface DeadChain {
  dir: string
  cardId: number
  state: 'stopped' | 'fault'
}

export interface RestartParts {
  db: DatabaseSync
  cards: CardTransitions
  processes: ProcessTable
  launchSwitchedOn: () => boolean
  clock: () => Date
  silentMs: number
}

export function relaunchKey(role: Role): string {
  return `relaunch:${role}`
}

const WITHDRAWN_REASONS: ReadonlySet<RestartReason> = new Set(['no_chain', 'chain_current', 'chain_dead', 'launch_off'])

const ENDED_CARD_STATES: readonly (string | null | undefined)[] = [CLOSED_CARD, DROPPED_CARD]

function cardStateOf(db: DatabaseSync, cardId: number): string | null | undefined {
  return cardStatesAmong(db, [cardId]).get(cardId)
}

function byDir(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function chainDirsOnTheBus(db: DatabaseSync): string[] {
  const dirs = events(db, { types: [CHAIN_OBSERVED, CHAIN_RESTARTED], legacy: EITHER_JOURNAL }).map(event => event.data?.dir)
  return [...new Set(dirs.filter((dir): dir is string => typeof dir === 'string'))].sort(byDir)
}

function unstoppedChains(db: DatabaseSync): ChainRow[] {
  return chainDirsOnTheBus(db).flatMap((dir) => {
    const chain = chainOfDir(db, dir)
    return chain === undefined || chain.state === 'stopped' ? [] : [chain]
  })
}

export class RestartExecutor {
  constructor(private readonly parts: RestartParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  restart(lease: Lease): RestartOutcome {
    try {
      assertHeld(this.parts.db, lease)
      const to = lease.head!
      const chain = chainOfCard(this.parts.db, lease.cardId)
      if (chain === undefined)
        return this.denied(lease, 'no_chain', `no chain of card #${lease.cardId} is on the bus`)
      if (chain.state !== 'stopped' && this.processGone(chain))
        return this.dead(lease, chain)
      if (chain.sha === to && chain.state !== 'fault')
        return this.denied(lease, 'chain_current', `the chain in ${chain.dir} already runs on ${to}`)
      if (chain.boundary === 0)
        return this.waiting(lease, chain, 'not_at_boundary')
      return this.handed(lease, chain, true)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  deadChains(actor: string): DeadChain[] {
    const found: DeadChain[] = []
    for (const chain of unstoppedChains(this.parts.db)) {
      if (!this.processGone(chain))
        continue
      const state = this.cardEnded(chain.card_id) ? 'stopped' : 'fault'
      if (state === chain.state)
        continue
      this.observeAs(actor, chain, state)
      found.push({ dir: chain.dir, cardId: chain.card_id, state })
    }
    return found
  }

  private processGone(chain: ChainRow): boolean {
    const found = chainProcess(chain, this.parts.processes)
    return found === 'gone' || (found === 'foreign' && chain.leader !== null)
  }

  private cardEnded(cardId: number): boolean {
    return ENDED_CARD_STATES.includes(cardStateOf(this.parts.db, cardId))
  }

  private dead(lease: Lease, chain: ChainRow): RestartOutcome {
    const gone = `the chain in ${chain.dir} died (PID ${chain.leader ?? chain.pid} is gone)`
    if (this.cardEnded(lease.cardId)) {
      this.observe(lease, chain, 'stopped')
      return this.denied(lease, 'chain_dead', `${gone} and card #${lease.cardId} is closed or dropped: the chain is stopped`)
    }
    if (chain.state !== 'fault')
      this.observe(lease, chain, 'fault')
    if (!this.parts.launchSwitchedOn())
      return this.denied(lease, 'launch_off', `${gone}: it restarts only while the launch worker is switched on in workers.json`)
    return this.handed(lease, chain, false)
  }

  private observe(lease: Lease, chain: ChainRow, state: ChainState): void {
    assertHeld(this.parts.db, lease)
    this.observeAs(lease.actor, chain, state)
  }

  private observeAs(actor: string, chain: ChainRow, state: ChainState): void {
    observeChain(this.parts.db, this.ts(), actor, { dir: chain.dir, parking: chain.parking, cardId: chain.card_id, sha: chain.sha, pid: chain.pid, leader: chain.leader, boundary: chain.boundary === 1, state })
  }

  private cardRunning(cardId: number): boolean {
    return cardStateOf(this.parts.db, cardId) === RUNNING_CARD
  }

  private stoppedAtTheBoundary(lease: Lease, seen: ChainRow, boundary: boolean): ChainRow | null {
    return inTransaction(this.parts.db, () => {
      assertHeld(this.parts.db, lease)
      const chain = chainOfDir(this.parts.db, seen.dir)
      if (chain === undefined || (boundary && chain.boundary === 0))
        return null
      stopChain(chain, this.parts.processes)
      return chain
    })
  }

  private handed(lease: Lease, seen: ChainRow, boundary: boolean): RestartOutcome {
    let chain: ChainRow | null
    try {
      chain = this.stoppedAtTheBoundary(lease, seen, boundary)
    }
    catch (error) {
      if (error instanceof StaleLease)
        throw error
      return this.denied(lease, 'stop_failed', messageOf(error))
    }
    if (chain === null)
      return this.waiting(lease, seen, 'not_at_boundary')
    this.observe(lease, chain, 'stopped')
    const cardStopped = this.cardRunning(chain.card_id)
    const events: BusEvent[] = cardStopped
      ? [{ ts: this.ts(), type: CARD_STOPPED, actor: lease.actor, cardId: chain.card_id, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${lease.taskKey}`, payload: { reason: 'fault', detail: `the chain in ${chain.dir} was handed to the launch node` }, legacy: false }]
      : []
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, events)
    return { kind: 'handed', taskKey: lease.taskKey, dir: chain.dir, cardId: chain.card_id, cardStopped }
  }

  private waiting(lease: Lease, chain: ChainRow, why: RestartWait): RestartOutcome {
    releaseTask(this.parts.db, this.parts.cards, this.ts(), lease, why)
    return { kind: 'waiting', taskKey: lease.taskKey, dir: chain.dir, why }
  }

  private denied(lease: Lease, reason: RestartReason, detail: string): RestartOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: null, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'restart', kind: 'technical', reason, detail }, legacy: false }
    const next = failTask(this.parts.db, this.parts.cards, ts, lease, { reason, withdraw: WITHDRAWN_REASONS.has(reason) }, this.parts.silentMs, [event])
    return { kind: 'denied', taskKey: lease.taskKey, reason, detail, next }
  }
}
