import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from './requests/reach.js'
import { answersWithdrawnByAClosedHold, appendEvent, CARD_HELD, CARD_RELEASED, holdLayersOf, PR_OBSERVED, QUEUE_ACTOR, queueAgain } from './requests/reach.js'

export const TAKEOVER_PUSH = 'takeover-push'

export type PushFold = (db: DatabaseSync, event: StoredEvent) => void

export interface HeldSlice {
  id: number
  head: string | null
  fields: { readonly request?: unknown }
}

export interface CardSlices {
  slice: ((type: typeof CARD_HELD, fields: readonly 'request'[]) => HeldSlice[]) & ((type: typeof PR_OBSERVED, fields: readonly never[]) => HeldSlice[])
}

export interface HoldReader {
  where: (filter: { card: number, from?: number }) => CardSlices
}

export type HoldReaderOf = (db: DatabaseSync) => HoldReader

function headBefore(read: HoldReader, cardId: number, before: number): string | null {
  return read.where({ card: cardId }).slice(PR_OBSERVED, []).filter(seen => seen.id < before && seen.head !== null).at(-1)?.head ?? null
}

function takeoverHold(read: HoldReader, cardId: number, heldId: number): HeldSlice | undefined {
  return read.where({ card: cardId, from: heldId }).slice(CARD_HELD, ['request']).find(held => held.id === heldId)
}

function takeoverIsTheLatestHold(db: DatabaseSync, cardId: number): number | null {
  const { owner, takeover } = holdLayersOf(db, cardId)
  if (takeover === null || (owner !== null && owner.id > takeover.id))
    return null
  return takeover.id
}

export function releaseTakeoverOnPush(db: DatabaseSync, read: HoldReader, event: StoredEvent): string[] {
  if (event.card_id === null || event.head === null)
    return []
  const cardId = Number(event.card_id)
  const heldId = takeoverIsTheLatestHold(db, cardId)
  if (heldId === null || event.id <= heldId)
    return []
  const hold = takeoverHold(read, cardId, heldId)
  if (hold === undefined || event.head === (hold.head ?? headBefore(read, cardId, heldId)))
    return []
  const request = typeof hold.fields.request === 'number' ? hold.fields.request : null
  const opened = holdLayersOf(db, cardId).opened
  const dedupeKey = `${CARD_RELEASED}:${TAKEOVER_PUSH}-${heldId}`
  const released = appendEvent(db, { ts: event.ts, type: CARD_RELEASED, actor: QUEUE_ACTOR, cardId, pr: event.pr, head: event.head, dedupeKey, payload: { ...(request === null ? {} : { request }), reason: `takeover pushed ${event.head}`, takeover: true }, legacy: false })
  if (!released)
    return []
  const withdrawn = answersWithdrawnByAClosedHold(db, cardId, opened)
  withdrawn.forEach(task => queueAgain(db, event.ts, task, request, `${TAKEOVER_PUSH}-${heldId}`))
  return withdrawn.map(task => task.task_key)
}

function releasingAfter(fold: PushFold | undefined, readerOf: HoldReaderOf): PushFold {
  return (db, event) => {
    fold?.(db, event)
    releaseTakeoverOnPush(db, readerOf(db), event)
  }
}

export function releasingTakeoverOnPush<F extends PushFold>(folds: Readonly<Record<string, F>>, pushes: readonly string[], readerOf: HoldReaderOf): Record<string, PushFold> {
  return { ...folds, ...Object.fromEntries(pushes.map(type => [type, releasingAfter(folds[type], readerOf)])) }
}
