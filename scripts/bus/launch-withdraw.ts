import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue } from './identifiers.js'
import { inTransaction } from './db.js'
import { generationOfKey } from './identifiers.js'
import { TASK_FAILED, TASK_LEASED } from './lease.js'
import { appendedAndReduced, generationField, QUEUE_ACTOR, QUEUED, STOPPED, TASK_REQUEUED, WITHDRAWN } from './queue.js'

export const WITHDRAW_LEGACY_FLAG = '--withdraw-legacy'
export const LEGACY_REASON = 'legacy'

const LAUNCH_TASKS_TO_WITHDRAW = `SELECT task_key, queue, card_id, pr, head, state, lease_gen FROM tasks WHERE queue = 'launch' AND state IN ('${QUEUED}', '${STOPPED}') ORDER BY id`

interface WithdrawnRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
  state: typeof QUEUED | typeof STOPPED
  lease_gen: number
}

function taskEvent(ts: string, type: string, row: WithdrawnRow, dedupeKey: string, fields: object): BusEvent {
  const generation = generationOfKey(row.task_key, { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined })
  return { ts, type, actor: QUEUE_ACTOR, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey, payload: { task_key: row.task_key, queue: row.queue, ...generationField(generation), ...fields }, legacy: false }
}

function withdrawn(db: DatabaseSync, ts: string, row: WithdrawnRow): void {
  const leaseGen = row.lease_gen + 1
  if (row.state === STOPPED)
    appendedAndReduced(db, taskEvent(ts, TASK_REQUEUED, row, `${TASK_REQUEUED}:${row.task_key}:${LEGACY_REASON}:${row.lease_gen}`, {}))
  appendedAndReduced(db, taskEvent(ts, TASK_LEASED, row, `${TASK_LEASED}:${row.task_key}:${leaseGen}`, { lease_gen: leaseGen }))
  appendedAndReduced(db, taskEvent(ts, TASK_FAILED, row, `${TASK_FAILED}:${row.task_key}:${leaseGen}`, { lease_gen: leaseGen, reason: LEGACY_REASON, next: WITHDRAWN }))
}

export function withdrawLegacyLaunchTasks(db: DatabaseSync, ts: string): string[] {
  const rows = db.prepare(LAUNCH_TASKS_TO_WITHDRAW).all() as unknown as WithdrawnRow[]
  for (const row of rows)
    inTransaction(db, () => withdrawn(db, ts, row))
  return rows.map(row => row.task_key)
}
