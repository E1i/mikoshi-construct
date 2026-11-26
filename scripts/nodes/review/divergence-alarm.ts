import type { DatabaseSync } from 'node:sqlite'
import type { EventRow } from '../../core/events-query.js'
import { createHash } from 'node:crypto'
import { appendEvent } from '../../core/db.js'
import { EITHER_JOURNAL, events } from '../../core/events-query.js'
import { BOARD_ALARM, BOARD_ALARM_CLEARED } from '../../core/events.js'

export const FOREIGN_DIVERGENCE = 'foreign-divergence'

const ALARM_KEY_PREFIX = `${BOARD_ALARM}:${FOREIGN_DIVERGENCE}:`

function digestOf(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16)
}

function clearings(db: DatabaseSync): EventRow[] {
  return events(db, { types: [BOARD_ALARM_CLEARED], legacy: EITHER_JOURNAL })
}

function clearedCount(db: DatabaseSync, digest: string): number {
  return clearings(db).filter(cleared => cleared.data?.digest === digest).length
}

interface ActiveAlarm {
  id: number
  dedupe_key: string
  digest: string
}

function activeAlarms(db: DatabaseSync): ActiveAlarm[] {
  const cleared = new Set(clearings(db).map(clearing => clearing.data?.alarm))
  return events(db, { types: [BOARD_ALARM], keyPrefix: ALARM_KEY_PREFIX, legacy: EITHER_JOURNAL })
    .filter(alarm => !cleared.has(alarm.dedupe_key))
    .map(alarm => ({ id: alarm.id, dedupe_key: alarm.dedupe_key, digest: alarm.data?.digest as string }))
}

export function recordForeignDivergences(db: DatabaseSync, actor: string, ts: string, foreign: string[]): void {
  const current = new Map(foreign.map(line => [digestOf(line), line]))
  const active = activeAlarms(db)
  for (const alarm of active.filter(each => !current.has(each.digest)))
    appendEvent(db, { ts, type: BOARD_ALARM_CLEARED, actor, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM_CLEARED}:${alarm.dedupe_key}`, payload: { reason: FOREIGN_DIVERGENCE, digest: alarm.digest, alarm: alarm.dedupe_key }, legacy: false })
  for (const [digest, line] of current) {
    const dedupeKey = `${ALARM_KEY_PREFIX}${digest}:${clearedCount(db, digest)}`
    appendEvent(db, { ts, type: BOARD_ALARM, actor, cardId: null, pr: null, head: null, dedupeKey, payload: { reason: FOREIGN_DIVERGENCE, digest, detail: line }, legacy: false })
  }
}
