import type { DatabaseSync } from 'node:sqlite'
import { CARD_HELD, CARD_RELEASED } from './events.js'

const LATEST_HOLD = `SELECT type, json_extract(payload, '$.reason') AS reason, json_extract(payload, '$.takeover') AS takeover FROM events WHERE card_id = ? AND legacy = 0 AND type IN ('${CARD_HELD}', '${CARD_RELEASED}') ORDER BY id DESC LIMIT 1`

export function cardHoldOf(db: DatabaseSync, cardId: number): string | null {
  const hold = db.prepare(LATEST_HOLD).get(cardId) as { type: string, reason: unknown, takeover: unknown } | undefined
  if (hold?.type !== CARD_HELD)
    return null
  const reason = typeof hold.reason === 'string' && hold.reason !== '' ? hold.reason : 'the hold names no reason'
  return `card #${cardId} is ${hold.takeover === null ? 'held for the owner' : 'taken over by the window'}: ${reason}`
}
