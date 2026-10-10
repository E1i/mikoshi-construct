import type { DatabaseSync } from 'node:sqlite'
import type { ChainRow } from './chain.js'
import type { BusEvent } from './db.js'
import type { AfterFailure, Lease } from './lease.js'
import type { Role, RoleLease } from './role.js'
import { CHAIN_RESTARTED, chainOfCard } from './chain.js'
import { messageOf } from './executor.js'
import { POLICY_DENIED } from './inbox.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from './lease.js'
import { assertRoleHeld, raiseRole } from './role.js'

export const SHORT_SHA = 7

export type RestartReason = 'no_chain' | 'chain_current' | 'launch_failed'
export type RestartWait = 'not_at_boundary' | 'checkout_behind'

export interface ChainLauncher {
  holds: (sha: string) => boolean
  launch: (chain: ChainRow, dir: string) => number
}

export type RestartOutcome
  = | { kind: 'restarted', taskKey: string, fromDir: string, dir: string, from: string, to: string, pid: number }
    | { kind: 'waiting', taskKey: string, dir: string, why: RestartWait }
    | { kind: 'denied', taskKey: string, reason: RestartReason, detail: string, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface RoleLauncher {
  raise: (role: Role, handoff: string) => number
}

export type RelaunchOutcome
  = | { kind: 'raised', role: Role, handoff: string, pid: number }
    | { kind: 'raise_failed', role: Role, handoff: string, detail: string }
    | { kind: 'fenced', taskKey: string }

export interface RestartParts {
  db: DatabaseSync
  launcher: ChainLauncher
  roles: RoleLauncher
  clock: () => Date
}

export function relaunchKey(role: Role): string {
  return `relaunch:${role}`
}

const WITHDRAWN_REASONS: ReadonlySet<RestartReason> = new Set(['no_chain', 'chain_current'])

export function restartDir(dir: string, to: string): string {
  return `${dir}-${to.slice(0, SHORT_SHA)}`
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
      if (chain.sha === to && chain.state !== 'fault')
        return this.denied(lease, 'chain_current', `the chain in ${chain.dir} already runs on ${to}`)
      if (chain.boundary === 0)
        return this.waiting(lease, chain, 'not_at_boundary')
      if (!this.parts.launcher.holds(to))
        return this.waiting(lease, chain, 'checkout_behind')
      assertHeld(this.parts.db, lease)
      return this.launched(lease, chain, to)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  relaunch(lease: RoleLease): RelaunchOutcome {
    try {
      assertRoleHeld(this.parts.db, lease)
      let pid: number
      try {
        pid = this.parts.roles.raise(lease.role, lease.handoff)
      }
      catch (error) {
        return { kind: 'raise_failed', role: lease.role, handoff: lease.handoff, detail: messageOf(error) }
      }
      raiseRole(this.parts.db, this.ts(), lease, pid)
      return { kind: 'raised', role: lease.role, handoff: lease.handoff, pid }
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: relaunchKey(lease.role) }
      throw error
    }
  }

  private launched(lease: Lease, chain: ChainRow, to: string): RestartOutcome {
    const dir = restartDir(chain.dir, to)
    let pid: number
    try {
      pid = this.parts.launcher.launch(chain, dir)
    }
    catch (error) {
      return this.denied(lease, 'launch_failed', messageOf(error))
    }
    const event: BusEvent = { ts: this.ts(), type: CHAIN_RESTARTED, actor: lease.actor, cardId: lease.cardId, pr: null, head: to, dedupeKey: `${CHAIN_RESTARTED}:${lease.taskKey}`, payload: { from_dir: chain.dir, dir, from: chain.sha, to, pid }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [event])
    return { kind: 'restarted', taskKey: lease.taskKey, fromDir: chain.dir, dir, from: chain.sha, to, pid }
  }

  private waiting(lease: Lease, chain: ChainRow, why: RestartWait): RestartOutcome {
    releaseTask(this.parts.db, this.ts(), lease, why)
    return { kind: 'waiting', taskKey: lease.taskKey, dir: chain.dir, why }
  }

  private denied(lease: Lease, reason: RestartReason, detail: string): RestartOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: null, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'restart', kind: 'technical', reason, detail }, legacy: false }
    const next = failTask(this.parts.db, ts, lease, { reason, withdraw: WITHDRAWN_REASONS.has(reason) }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, reason, detail, next }
  }
}
