import type { DatabaseSync } from 'node:sqlite'
import { WINDOW_SUBAGENT_EVENT } from '../../src/commands/board/bus.js'
import { appendEvent } from '../bus/db.js'

export const WINDOW_ACTOR = 'owner'

export interface WindowSubagent {
  session: string
  role: string
  task: string
  phase: 'started' | 'ended'
  tree?: string
  step?: string
}

export function recordWindowSubagent(db: DatabaseSync, subagent: WindowSubagent, at: Date): boolean {
  const { session, role, task, phase, tree, step } = subagent
  return appendEvent(db, {
    ts: at.toISOString(),
    type: WINDOW_SUBAGENT_EVENT,
    actor: WINDOW_ACTOR,
    cardId: null,
    pr: null,
    head: null,
    dedupeKey: `${WINDOW_SUBAGENT_EVENT}:${session}:${phase}`,
    payload: { session, role, task, phase, tree: tree ?? null, step: step ?? null },
    legacy: false,
  })
}
