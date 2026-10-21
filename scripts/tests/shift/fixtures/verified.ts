import { existsSync } from 'node:fs'
import { BUSY_TIMEOUT_MS } from '../../../bus/db.js'
import { openDatabase } from '../../../bus/sqlite.js'
import { CARD_VERIFIED } from '../../../core/events.js'

export function verifiedClosings(bus: string): Record<string, unknown>[] {
  if (!existsSync(bus))
    return []
  const db = openDatabase(bus, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare('SELECT card_id, payload FROM events WHERE type = ? AND legacy = 0 ORDER BY id').all(CARD_VERIFIED) as { card_id: number, payload: string }[]
    return rows.map(row => ({ task: String(row.card_id), ...(JSON.parse(row.payload) as Record<string, unknown>) }))
  }
  finally {
    db.close()
  }
}
