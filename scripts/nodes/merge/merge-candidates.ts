import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Admits, Candidate, CandidateRules, QueuedTask, QueueSource, RequeueRow } from '../../core/queue.js'
import type { TaskRow } from '../../core/tasks-query.js'
import { openDecisionWaitsOfCard } from '../../core/card-readings.js'
import { byId, EITHER_JOURNAL, events } from '../../core/events-query.js'
import { TASK_FAILED, TASK_REQUEUED } from '../../core/events.js'
import { anOpenPrOnTheHead } from '../../core/pr-readings.js'
import { decidedPastRoundLimit, holdsTheTurn, mergeCandidateRows, mergeCandidateRowsWithoutPass, noTurnHeldBeside, openCandidates, QUESTION_OPEN, recordedOrder, WITHDRAWN } from '../../core/queue.js'
import { ofQueue } from '../../core/tasks-query.js'

export interface LaterShards {
  named: string
  window: string
}

export interface MergeParts {
  rules: CandidateRules
  laterShards: LaterShards
}

function byTaskKey(a: TaskRow, b: TaskRow): number {
  return a.task_key < b.task_key ? -1 : a.task_key > b.task_key ? 1 : 0
}

function withdrawnMergesOnTheirOpenHead(db: DatabaseSync): TaskRow[] {
  return ofQueue(db, 'merge').filter(task => task.state === WITHDRAWN && anOpenPrOnTheHead(db, task.pr, task.head)).sort(byTaskKey)
}

function requeueRowOf(task: TaskRow): RequeueRow {
  return { task_key: task.task_key, queue: 'merge', card_id: task.card_id, pr: task.pr, head: task.head, failure: task.event_id }
}

function parkedOnAQuestion(db: DatabaseSync, task: TaskRow): boolean {
  const parked = byId(db, task.event_id)
  return parked?.type === TASK_FAILED && parked.data?.reason === QUESTION_OPEN
}

function mergesParkedOnAQuestionNowClosed(db: DatabaseSync): RequeueRow[] {
  return withdrawnMergesOnTheirOpenHead(db)
    .filter(task => parkedOnAQuestion(db, task) && openDecisionWaitsOfCard(db, task.card_id).length === 0)
    .map(requeueRowOf)
}

function aShardLaterThanTheTask(shards: string): string {
  return `SELECT EXISTS (SELECT 1 FROM (${shards}) AS shard WHERE shard.event_id > tasks.event_id) AS later
  FROM (SELECT ? AS card_id, ? AS pr, ? AS event_id) AS tasks`
}

function withdrawnMergesALaterShardOf(db: DatabaseSync, shards: string, ...shardValues: SQLInputValue[]): RequeueRow[] {
  const later = db.prepare(aShardLaterThanTheTask(shards))
  return withdrawnMergesOnTheirOpenHead(db)
    .filter(task => events(db, { types: [TASK_REQUEUED], task: task.task_key, legacy: EITHER_JOURNAL }).length === 0
      && Number((later.get(...shardValues, task.card_id, task.pr, task.event_id) as { later: number }).later) === 1)
    .map(requeueRowOf)
}

function mergeRows(db: DatabaseSync, ts: string, rules: CandidateRules): Candidate[] {
  const order = recordedOrder(db)
  const inTurn: Admits = row => holdsTheTurn(order, row.pr) && !order.needUpdate.has(row.pr!)
  const decided = decidedPastRoundLimit(db, ts, rules)
  const merged = rules.mergedCards(db)
  const prs = rules.prs(db)
  return [...mergeCandidateRows(db, prs, merged).filter(inTurn).filter(rules.reviewedUnderTheCardDecision(db, ts)), ...mergeCandidateRowsWithoutPass(db, prs, merged).filter(row => decided(row) && (inTurn(row) || noTurnHeldBeside(order, row.pr)))]
}

export function mergeCandidates(db: DatabaseSync, ts: string, rules: CandidateRules): QueuedTask[] {
  return openCandidates(db, ts, 'merge', mergeRows(db, ts, rules), rules)
}

export function mergeSource(parts: MergeParts): QueueSource {
  const { named, window } = parts.laterShards
  return {
    queue: 'merge',
    requeue: (db, ts) => [...withdrawnMergesALaterShardOf(db, named), ...withdrawnMergesALaterShardOf(db, window, ts), ...mergesParkedOnAQuestionNowClosed(db)],
  }
}
