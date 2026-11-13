import type { DatabaseSync } from 'node:sqlite'
import type { Understood } from '../core/bus-version.js'
import process from 'node:process'
import type { HolderStart, Lease } from '../core/lease.js'
import type { NodeKind, NodeSupply, WorkerIdentity } from '../core/node.js'
import type { Projections } from '../core/reducer.js'
import type { SessionMeasure } from './heartbeat.js'
import { CARD_FOLDS, CARDS_PROJECTION } from '../core/card-automaton.js'
import { admittedCardVersion } from '../core/card-bodies.js'
import { CHAINS_PROJECTION } from '../core/chain.js'
import { foreignVersion, instanceOf } from '../core/node.js'
import { TASKS_PROJECTION } from '../core/queue.js'
import { CARD_END_FOLDS, OWNER_WAIT_FOLDS, PLAN_FOLDS, PR_FOLDS } from '../core/reducer.js'
import { ROLES_PROJECTION } from '../nodes/restart/role.js'
import { DECISION_FOLDS } from '../policy/decisions/index.js'
import { CHECK_MS, TICK_MS } from '../ports/netwatch.js'
import { busSessionPulse, heartbeatEnv, measureCardSession, ownStart, recordProcessHeartbeat } from './heartbeat.js'
import { SILENT_MS } from './liveness-sites.js'
import { ownIdentity } from './recorded-worker.js'
import { slotsOf, slotsVariable } from './scheduler.js'

export interface NodeLiveness {
  silentMs: number
}

export function workerIdentity(worker: string, start: HolderStart, env: NodeJS.ProcessEnv = process.env): WorkerIdentity {
  const own = ownIdentity()
  const proven = own !== null && own.pid === start.pid ? own : null
  return { worker, pid: start.pid, started: start.started, ...instanceOf(env), pgid: proven?.pgid ?? null, lstart: proven?.lstart ?? start.started }
}

export function nodeLiveness(): NodeLiveness {
  return { silentMs: SILENT_MS }
}

export type CardSessionMeasure = SessionMeasure

export function refusesForeignCard(db: DatabaseSync, lease: Lease, understands: Understood): string | null {
  const version = admittedCardVersion(db, lease.cardId)
  return version === null ? null : foreignVersion(understands, 'card', version, `card #${lease.cardId} (${lease.taskKey})`)
}

export function nodeSupply(): NodeSupply {
  return {
    cadence: { checkMs: CHECK_MS, tickMs: TICK_MS },
    recordProcessHeartbeat,
    slotsOf: (kind: NodeKind, env: NodeJS.ProcessEnv) => slotsOf(kind, env),
    ownStart,
    ownIdentity: () => ownIdentity(),
    refuses: refusesForeignCard,
  }
}

export function withSlots(kind: NodeKind, env: NodeJS.ProcessEnv, slots: number): NodeJS.ProcessEnv {
  return { ...env, [slotsVariable(kind)]: String(slots) }
}

export function cardSessionPulse(busPath: string, clock: () => Date, measure: CardSessionMeasure = measureCardSession): (lease: Lease, session: string) => string {
  return busSessionPulse(busPath, clock, measure)
}

export function launchSessionEnv(cardId: number): Record<string, string> {
  return heartbeatEnv({ cardId, pr: null, head: null, queue: 'launch' })
}

export function busProjections(): Projections {
  return {
    folds: [PR_FOLDS, TASKS_PROJECTION.folds, CHAINS_PROJECTION.folds, ROLES_PROJECTION.folds, DECISION_FOLDS, CARD_FOLDS, OWNER_WAIT_FOLDS, PLAN_FOLDS, CARD_END_FOLDS],
    incremental: [ROLES_PROJECTION, TASKS_PROJECTION, CHAINS_PROJECTION, CARDS_PROJECTION],
  }
}
