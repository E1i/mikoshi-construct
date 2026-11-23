import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue } from './identifiers.js'
import { appendEvent } from './db.js'
import { EITHER_JOURNAL, events, ofCard } from './events-query.js'
import { CARD_HELD, CARD_RELEASED, OPEN_QUESTION, OUTSIDE_TOUCHES, TASK_FAILED, TASK_REQUEUED } from './events.js'
import { generationOfKey } from './identifiers.js'
import { QUEUE_ACTOR, TASK_FOLDS, WITHDRAWN } from './queue.js'
import { storedByKey } from './stored.js'
import * as tasks from './tasks-query.js'

export const HOLD_RECHECK_MS = 5 * 60_000

export const LIVE_SESSION_IN_THE_TREE = 'live_session_in_the_tree'

export type SessionStopCode = typeof OUTSIDE_TOUCHES | typeof OPEN_QUESTION

export const SESSION_STOP_CODES: readonly SessionStopCode[] = [OUTSIDE_TOUCHES, OPEN_QUESTION]

export interface SessionStop {
  code: SessionStopCode
  blocker: string
  paths: string[]
}

export function sessionStopOf(questions: readonly string[], outsideTheTouches: (text: string) => string[]): SessionStop | null {
  if (questions.length === 0)
    return null
  const paths = outsideTheTouches(questions.join('\n'))
  return { code: paths.length > 0 ? OUTSIDE_TOUCHES : OPEN_QUESTION, blocker: questions.join('; '), paths }
}

export function holdRecheckAt(now: Date): string {
  return new Date(now.getTime() + HOLD_RECHECK_MS).toISOString()
}

export interface QueueTaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
  state: string
}

const ANSWER_QUEUE: Queue = 'answer'

const HELD_FOR_OWNER = 'held_for_owner'
const HOLD_EVENTS = [CARD_HELD, CARD_RELEASED]
const NO_REASON = 'the hold names no reason'

export interface HoldLayer {
  id: number
  reason: string
}

export interface HoldLayers {
  owner: HoldLayer | null
  takeover: HoldLayer | null
  opened: number | null
}

function withdrawnForTheOwner(db: DatabaseSync, opened: number, eventIds: readonly number[]): Set<number> {
  const withdrawals = events(db, { types: [TASK_FAILED], since: opened, ids: eventIds, legacy: EITHER_JOURNAL })
  return new Set(withdrawals.filter(withdrawal => withdrawal.data?.reason === HELD_FOR_OWNER).map(withdrawal => withdrawal.id))
}

function answersWithdrawnSince(db: DatabaseSync, cardId: number, opened: number): QueueTaskRow[] {
  const rows = tasks.ofCard(db, cardId, { queue: ANSWER_QUEUE, state: WITHDRAWN, after: opened }).sort((a, b) => a.task_key < b.task_key ? -1 : a.task_key > b.task_key ? 1 : 0)
  const withdrawn = withdrawnForTheOwner(db, opened, rows.map(row => row.event_id))
  return rows.filter(row => withdrawn.has(row.event_id)).map(row => ({ task_key: row.task_key, queue: ANSWER_QUEUE, card_id: row.card_id, pr: row.pr, head: row.head, state: row.state }))
}

function latestLayerOf(layers: HoldLayers): 'owner' | 'takeover' | null {
  if (layers.owner === null)
    return layers.takeover === null ? null : 'takeover'
  return layers.takeover === null || layers.owner.id > layers.takeover.id ? 'owner' : 'takeover'
}

export function holdLayersOf(db: DatabaseSync, cardId: number): HoldLayers {
  const layers: HoldLayers = { owner: null, takeover: null, opened: null }
  for (const { id, type, data } of ofCard(db, cardId, { types: HOLD_EVENTS })) {
    const row = { id, reason: data?.reason, takeover: data?.takeover ?? null }
    if (type === CARD_RELEASED) {
      const latest = latestLayerOf(layers)
      if (latest !== null)
        layers[latest] = null
      if (latestLayerOf(layers) === null)
        layers.opened = null
      continue
    }
    const kind = row.takeover === null ? 'owner' : 'takeover'
    const reason = typeof row.reason === 'string' && row.reason !== '' ? row.reason : NO_REASON
    layers[kind] = { id: layers[kind]?.id ?? Number(row.id), reason }
    layers.opened ??= Number(row.id)
  }
  return layers
}

export function holderOf(layers: HoldLayers): string | null {
  const latest = latestLayerOf(layers)
  return latest === null ? null : latest === 'owner' ? 'the owner' : 'the window'
}

export function answersWithdrawnByAClosedHold(db: DatabaseSync, cardId: number, opened: number | null): QueueTaskRow[] {
  return opened === null || holderOf(holdLayersOf(db, cardId)) !== null ? [] : answersWithdrawnSince(db, cardId, opened)
}

export function holdThatStays(db: DatabaseSync, cardId: number): string | null {
  const holder = holderOf(holdLayersOf(db, cardId))
  return holder === null ? null : `; queued nothing: ${cardHoldOf(db, cardId)}; the answer resumes when ${holder} releases it`
}

export function ownerHoldGround(db: DatabaseSync, cardId: number): { named: string } | null {
  const { owner } = holdLayersOf(db, cardId)
  return owner === null ? null : { named: `the owner holds it: ${owner.reason}` }
}

export function cardHoldOf(db: DatabaseSync, cardId: number): string | null {
  const { owner, takeover } = holdLayersOf(db, cardId)
  if (takeover !== null)
    return `card #${cardId} is taken over by the window: ${takeover.reason}${owner === null ? '' : ` (held for the owner: ${owner.reason})`}`
  return owner === null ? null : `card #${cardId} is held for the owner: ${owner.reason}`
}

export function queueAgain(db: DatabaseSync, ts: string, task: QueueTaskRow, request: number | null, after: string): void {
  const plain = { queue: task.queue, cardId: task.card_id, pr: task.pr ?? undefined, head: task.head ?? undefined }
  const generation = generationOfKey(task.task_key, plain)
  const event: BusEvent = { ts, type: TASK_REQUEUED, actor: QUEUE_ACTOR, cardId: task.card_id, pr: task.pr, head: task.head, dedupeKey: `${TASK_REQUEUED}:${task.task_key}:${after}`, payload: { task_key: task.task_key, queue: task.queue, ...(generation === undefined ? {} : { generation }), ...(request === null ? {} : { request }) }, legacy: false }
  if (appendEvent(db, event))
    TASK_FOLDS[TASK_REQUEUED]!(db, storedByKey(db, event.dedupeKey))
}
