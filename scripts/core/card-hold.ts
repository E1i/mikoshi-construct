import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue } from './identifiers.js'
import { appendEvent } from './db.js'
import { CARD_HELD, CARD_RELEASED, TASK_FAILED, TASK_REQUEUED } from './events.js'
import { generationOfKey } from './identifiers.js'
import { QUEUE_ACTOR, TASK_FOLDS, WITHDRAWN } from './queue.js'
import { storedByKey } from './stored.js'

export const HOLD_RECHECK_MS = 5 * 60_000

export interface QueueTaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
  state: string
}

const ANSWERS_WITHDRAWN_SINCE = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.state FROM tasks
  JOIN events AS withdrawal ON withdrawal.id = tasks.event_id
  WHERE tasks.card_id = ? AND tasks.queue = 'answer' AND tasks.state = ? AND withdrawal.id > ?
    AND withdrawal.type = '${TASK_FAILED}' AND json_extract(withdrawal.payload, '$.reason') = 'held_for_owner'
  ORDER BY tasks.task_key
`

const HOLDS_OF_CARD = `SELECT id, type, json_extract(payload, '$.reason') AS reason, json_extract(payload, '$.takeover') AS takeover FROM events WHERE card_id = ? AND legacy = 0 AND type IN ('${CARD_HELD}', '${CARD_RELEASED}') ORDER BY id`
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

interface HoldRow {
  id: number
  type: string
  reason: unknown
  takeover: unknown
}

function latestLayerOf(layers: HoldLayers): 'owner' | 'takeover' | null {
  if (layers.owner === null)
    return layers.takeover === null ? null : 'takeover'
  return layers.takeover === null || layers.owner.id > layers.takeover.id ? 'owner' : 'takeover'
}

export function holdLayersOf(db: DatabaseSync, cardId: number): HoldLayers {
  const layers: HoldLayers = { owner: null, takeover: null, opened: null }
  for (const row of db.prepare(HOLDS_OF_CARD).all(cardId) as unknown as HoldRow[]) {
    if (row.type === CARD_RELEASED) {
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
  return opened === null || holderOf(holdLayersOf(db, cardId)) !== null ? [] : db.prepare(ANSWERS_WITHDRAWN_SINCE).all(cardId, WITHDRAWN, opened) as unknown as QueueTaskRow[]
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
