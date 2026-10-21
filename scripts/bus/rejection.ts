import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import { REJECTED } from '../core/events.js'
import { appendEvent } from './db.js'
import { Rejection } from './stored.js'

function recordRejection(db: DatabaseSync, event: StoredEvent, reason: string): void {
  appendEvent(db, {
    ts: event.ts,
    type: REJECTED,
    actor: 'reducer',
    cardId: event.card_id,
    pr: event.pr,
    head: event.head,
    dedupeKey: `${REJECTED}:${event.dedupe_key}`,
    payload: { event_id: event.id, type: event.type, reason },
    legacy: false,
  })
}

export function appliedOrRejected(db: DatabaseSync, event: StoredEvent, apply: Fold): boolean {
  db.exec('SAVEPOINT reducer_event')
  try {
    apply(db, event)
    db.exec('RELEASE reducer_event')
    return true
  }
  catch (error) {
    db.exec('ROLLBACK TO reducer_event')
    db.exec('RELEASE reducer_event')
    if (!(error instanceof Rejection))
      throw error
    recordRejection(db, event, error.message)
    return false
  }
}
