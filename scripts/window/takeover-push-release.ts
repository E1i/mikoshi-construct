import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from './requests/reach.js'
import { answersWithdrawnByAClosedHold, appendEvent, CARD_HELD, CARD_RELEASED, holdLayersOf, PR_OBSERVED, QUEUE_ACTOR, queueAgain } from './requests/reach.js'

export const TAKEOVER_PUSH = 'takeover-push'

export type PushFold = (db: DatabaseSync, event: StoredEvent) => void

const HEAD_OF_CARD_BEFORE = `SELECT head FROM events WHERE card_id = ? AND legacy = 0 AND type = '${PR_OBSERVED}' AND head IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1`

const TAKEOVER_HOLD = `SELECT json_extract(payload, '$.request') AS request, head FROM events WHERE id = ? AND type = '${CARD_HELD}'`

interface TakeoverHold {
  request: unknown
  head: string | null
}

export function headAtTakeover(db: DatabaseSync, cardId: number, before = Number.MAX_SAFE_INTEGER): string | null {
  const row = db.prepare(HEAD_OF_CARD_BEFORE).get(cardId, before) as { head: string } | undefined
  return row?.head ?? null
}

function takeoverIsTheLatestHold(db: DatabaseSync, cardId: number): number | null {
  const { owner, takeover } = holdLayersOf(db, cardId)
  if (takeover === null || (owner !== null && owner.id > takeover.id))
    return null
  return takeover.id
}

export function releaseTakeoverOnPush(db: DatabaseSync, event: StoredEvent): string[] {
  if (event.card_id === null || event.head === null)
    return []
  const cardId = Number(event.card_id)
  const heldId = takeoverIsTheLatestHold(db, cardId)
  if (heldId === null || event.id <= heldId)
    return []
  const hold = db.prepare(TAKEOVER_HOLD).get(heldId) as TakeoverHold | undefined
  if (hold === undefined || event.head === (hold.head ?? headAtTakeover(db, cardId, heldId)))
    return []
  const request = typeof hold.request === 'number' ? hold.request : null
  const opened = holdLayersOf(db, cardId).opened
  const dedupeKey = `${CARD_RELEASED}:${TAKEOVER_PUSH}-${heldId}`
  const released = appendEvent(db, { ts: event.ts, type: CARD_RELEASED, actor: QUEUE_ACTOR, cardId, pr: event.pr, head: event.head, dedupeKey, payload: { ...(request === null ? {} : { request }), reason: `takeover pushed ${event.head}`, takeover: true }, legacy: false })
  if (!released)
    return []
  const withdrawn = answersWithdrawnByAClosedHold(db, cardId, opened)
  withdrawn.forEach(task => queueAgain(db, event.ts, task, request, `${TAKEOVER_PUSH}-${heldId}`))
  return withdrawn.map(task => task.task_key)
}

function releasingAfter(fold: PushFold | undefined): PushFold {
  return (db, event) => {
    fold?.(db, event)
    releaseTakeoverOnPush(db, event)
  }
}

export function releasingTakeoverOnPush<F extends PushFold>(folds: Readonly<Record<string, F>>, pushes: readonly string[]): Record<string, PushFold> {
  return { ...folds, ...Object.fromEntries(pushes.map(type => [type, releasingAfter(folds[type])])) }
}
