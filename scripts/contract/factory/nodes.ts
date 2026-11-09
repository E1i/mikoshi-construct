import type { NodeDeclaration } from '../../core/node.js'
import { ANSWER_NODE } from '../../nodes/answer/answer-worker.js'
import { CLOSE_NODE } from '../../nodes/close/close-worker.js'
import { LAUNCH_NODE } from '../../nodes/launch/launch-worker.js'
import { MERGE_NODE } from '../../nodes/merge/merge-worker.js'
import { REVIEW_NODE } from '../../nodes/review/review-worker.js'
import { UPDATE_NODE } from '../../nodes/update/update-worker.js'
import { WITNESS_NODE } from '../../nodes/witness/witness-worker.js'

export interface NodeRow {
  on: readonly string[]
  understands: { bus: readonly number[], card: readonly number[] }
}

export interface NodesSection {
  nodesVersion: number
  declared: Record<string, NodeRow>
}

export const NODES_VERSION = 2

export const NODE_DECLARATIONS: readonly NodeDeclaration[] = [ANSWER_NODE, CLOSE_NODE, LAUNCH_NODE, MERGE_NODE, REVIEW_NODE, UPDATE_NODE, WITNESS_NODE]

export function nodesSection(declarations: readonly NodeDeclaration[] = NODE_DECLARATIONS): NodesSection {
  return {
    nodesVersion: NODES_VERSION,
    declared: Object.fromEntries(declarations.map(({ kind, on, understands }) => [kind, { on: [...on], understands: { bus: [...understands.bus], card: [...understands.card] } }])),
  }
}
