import type { Lease } from '../core/lease.js'
import type { NodeKind, NodeSupply } from '../core/node.js'
import type { Projections } from '../core/reducer.js'
import type { SessionMeasure } from './heartbeat.js'
import { CARD_FOLDS, CARDS_PROJECTION } from '../core/card-automaton.js'
import { CHAINS_PROJECTION } from '../core/chain.js'
import { TASKS_PROJECTION } from '../core/queue.js'
import { CARD_END_FOLDS, OWNER_WAIT_FOLDS, PLAN_FOLDS, PR_FOLDS } from '../core/reducer.js'
import { ROLES_PROJECTION } from '../nodes/restart/role.js'
import { DECISION_FOLDS } from '../policy/decisions/index.js'
import { CHECK_MS, TICK_MS } from '../ports/netwatch.js'
import { busSessionPulse, heartbeatEnv, measureCardSession, ownStart, recordProcessHeartbeat } from './heartbeat.js'
import { slotsOf, slotsVariable } from './scheduler.js'

export type CardSessionMeasure = SessionMeasure

export function nodeSupply(): NodeSupply {
  return {
    cadence: { checkMs: CHECK_MS, tickMs: TICK_MS },
    recordProcessHeartbeat,
    slotsOf: (kind: NodeKind, env: NodeJS.ProcessEnv) => slotsOf(kind, env),
    ownStart,
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
