import type { DatabaseSync } from 'node:sqlite'
import type { Admits, Candidate, CandidateRules, QueuedTask, QueueSource, RequeueRow } from '../../core/queue.js'
import { TASK_FAILED, TASK_REQUEUED } from '../../core/events.js'
import { candidateRows, decidedPastRoundLimit, holdsTheTurn, MERGE_CANDIDATES, MERGE_CANDIDATES_WITHOUT_PASS, noTurnHeldBeside, openCandidates, openDecisionWaitsOf, QUESTION_OPEN, recordedOrder, WITHDRAWN } from '../../core/queue.js'

export interface LaterShards {
  named: string
  window: string
}

export interface MergeParts {
  rules: CandidateRules
  laterShards: LaterShards
}

const MERGES_PARKED_ON_A_QUESTION_NOW_CLOSED = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  JOIN events AS parked ON parked.id = tasks.event_id
  WHERE tasks.queue = 'merge' AND tasks.state = '${WITHDRAWN}' AND prs.state = 'open' AND prs.head = tasks.head
    AND parked.type = '${TASK_FAILED}' AND json_extract(parked.payload, '$.reason') = '${QUESTION_OPEN}'
    AND NOT EXISTS (${openDecisionWaitsOf('tasks.card_id')})
  ORDER BY tasks.task_key
`

function withdrawnMergesALaterShardOf(shards: string): string {
  return `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'merge' AND tasks.state = '${WITHDRAWN}' AND prs.state = 'open' AND prs.head = tasks.head
    AND NOT EXISTS (SELECT 1 FROM events AS requeued WHERE requeued.type = '${TASK_REQUEUED}' AND json_extract(requeued.payload, '$.task_key') = tasks.task_key)
    AND EXISTS (SELECT 1 FROM (${shards}) AS shard WHERE shard.event_id > tasks.event_id)
  ORDER BY tasks.task_key
`
}

function mergeRows(db: DatabaseSync, ts: string, rules: CandidateRules): Candidate[] {
  const order = recordedOrder(db)
  const inTurn: Admits = row => holdsTheTurn(order, row.pr) && !order.needUpdate.has(row.pr!)
  const decided = decidedPastRoundLimit(db, ts, rules)
  const merged = rules.mergedCards(db)
  return [...candidateRows(db, MERGE_CANDIDATES, inTurn, merged).filter(rules.reviewedUnderTheCardDecision(db, ts)), ...candidateRows(db, MERGE_CANDIDATES_WITHOUT_PASS, row => decided(row) && (inTurn(row) || noTurnHeldBeside(order, row.pr)), merged)]
}

export function mergeCandidates(db: DatabaseSync, ts: string, rules: CandidateRules): QueuedTask[] {
  return openCandidates(db, ts, 'merge', mergeRows(db, ts, rules), rules)
}

export function mergeSource(parts: MergeParts): QueueSource {
  const named = withdrawnMergesALaterShardOf(parts.laterShards.named)
  const window = withdrawnMergesALaterShardOf(parts.laterShards.window)
  return {
    queue: 'merge',
    requeue: (db, ts) => [...db.prepare(named).all(), ...db.prepare(window).all(ts), ...db.prepare(MERGES_PARKED_ON_A_QUESTION_NOW_CLOSED).all()] as unknown as RequeueRow[],
  }
}
