import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { BOARD_ALARM, BOARD_ALARM_CLEARED } from '../../core/events.js'
import { appendEvent } from '../../core/db.js'

export const FOREIGN_DIVERGENCE = 'foreign-divergence'

const ALARM_KEY_PREFIX = `${BOARD_ALARM}:${FOREIGN_DIVERGENCE}:`

function digestOf(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16)
}

function clearedCount(db: DatabaseSync, digest: string): number {
  return Number((db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.digest') = ?`).get(BOARD_ALARM_CLEARED, digest) as { n: number }).n)
}

interface ActiveAlarm {
  id: number
  dedupe_key: string
  digest: string
}

function activeAlarms(db: DatabaseSync): ActiveAlarm[] {
  return db.prepare(`
    SELECT alarm.id, alarm.dedupe_key, json_extract(alarm.payload, '$.digest') AS digest FROM events AS alarm
    WHERE alarm.type = ? AND alarm.dedupe_key LIKE ? || '%'
      AND NOT EXISTS (SELECT 1 FROM events AS cleared WHERE cleared.type = ? AND json_extract(cleared.payload, '$.alarm') = alarm.dedupe_key)
    ORDER BY alarm.id
  `).all(BOARD_ALARM, ALARM_KEY_PREFIX, BOARD_ALARM_CLEARED) as unknown as ActiveAlarm[]
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
