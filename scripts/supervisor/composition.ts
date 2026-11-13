import type { Projections } from '../core/reducer.js'
import { CARD_FOLDS, CARDS_PROJECTION } from '../core/card-automaton.js'
import { CHAINS_PROJECTION } from '../core/chain.js'
import { TASKS_PROJECTION } from '../core/queue.js'
import { CARD_END_FOLDS, OWNER_WAIT_FOLDS, PLAN_FOLDS, PR_FOLDS } from '../core/reducer.js'
import { ROLES_PROJECTION } from '../nodes/restart/role.js'
import { DECISION_FOLDS } from '../policy/decisions/index.js'
import { SILENT_MS } from './liveness-sites.js'

export interface NodeLiveness {
  silentMs: number
}

export function nodeLiveness(): NodeLiveness {
  return { silentMs: SILENT_MS }
}

export function busProjections(): Projections {
  return {
    folds: [PR_FOLDS, TASKS_PROJECTION.folds, CHAINS_PROJECTION.folds, ROLES_PROJECTION.folds, DECISION_FOLDS, CARD_FOLDS, OWNER_WAIT_FOLDS, PLAN_FOLDS, CARD_END_FOLDS],
    incremental: [ROLES_PROJECTION, TASKS_PROJECTION, CHAINS_PROJECTION, CARDS_PROJECTION],
  }
}
