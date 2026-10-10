import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { inForce, parseDecisions } from '../decisions/decisions.js'
import { appendEvent } from './db.js'
import { DECISIONS_IMPORTED } from './decisions.js'
import { NETWATCH } from './observations.js'

const LAST_IMPORTED = `SELECT json_extract(payload, '$.sha256') AS sha FROM events WHERE type = '${DECISIONS_IMPORTED}' ORDER BY id DESC LIMIT 1`

function lastImportedSha(db: DatabaseSync): string | null {
  const row = db.prepare(LAST_IMPORTED).get() as { sha: string | null } | undefined
  return row?.sha ?? null
}

export function importOwnerDecisions(db: DatabaseSync, text: string, ts: string): boolean {
  const sha256 = createHash('sha256').update(text).digest('hex')
  if (lastImportedSha(db) === sha256)
    return false
  const decisions = inForce(parseDecisions(text).decisions).map(decision => ({ decision_id: decision.number, text: decision.body, scope: decision.cards }))
  return appendEvent(db, { ts, type: DECISIONS_IMPORTED, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: `${DECISIONS_IMPORTED}:${sha256}:${ts}`, payload: { sha256, decisions }, legacy: false })
}

export function decisionsIntake(db: DatabaseSync, file: string, clock: () => Date): () => void {
  return () => {
    if (existsSync(file))
      importOwnerDecisions(db, readFileSync(file, 'utf8'), clock().toISOString())
  }
}
