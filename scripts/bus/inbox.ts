import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from './db.js'

export const POLICY_DENIED = 'policy.denied'
export const CARD_STOPPED = 'card.stopped'
export const CARD_STARTED = 'card.started'
export const CARD_ANSWERED = 'card.answered'
export const DECISION_RECORDED = 'decision.recorded'
export const QUESTION_OWNER = 'question.owner'
export const OWNER = 'owner'
export const PREFIX = '[bus:inbox] '

const OWNER_INBOX = `
  SELECT id, type, card_id, pr, head, payload FROM events AS item
  WHERE item.legacy = 0 AND (
    (item.type = '${POLICY_DENIED}' AND json_extract(item.payload, '$.kind') = 'authority')
    OR (item.type = '${CARD_STOPPED}' AND json_extract(item.payload, '$.reason') = '${QUESTION_OWNER}' AND NOT EXISTS (
      SELECT 1 FROM decisions AS answer, json_each(answer.scope) AS named
      WHERE answer.event_id > item.id AND named.value = item.card_id
    ))
  )
  ORDER BY id
`

export interface InboxLine {
  id: number
  type: string
  card_id: number | null
  pr: number | null
  head: string | null
  payload: string
}

export function ownerInbox(db: DatabaseSync): InboxLine[] {
  return db.prepare(OWNER_INBOX).all() as unknown as InboxLine[]
}

function field(payload: Record<string, unknown>, name: string): string | null {
  return typeof payload[name] === 'string' ? payload[name] : null
}

export function inboxText(line: InboxLine): string {
  const payload = JSON.parse(line.payload) as Record<string, unknown>
  const what = line.type === POLICY_DENIED ? `authority ${field(payload, 'rule') ?? '-'}` : QUESTION_OWNER
  const parts = [
    `${line.type} ${what}`,
    line.card_id === null ? null : `card #${line.card_id}`,
    line.pr === null ? null : `PR #${line.pr}`,
    field(payload, 'command'),
    field(payload, 'detail'),
  ]
  return `${PREFIX}${parts.filter(part => part !== null).join(' · ')}`
}

export function runInbox(db: DatabaseSync, out: (line: string) => void): number {
  const lines = ownerInbox(db)
  for (const line of lines)
    out(inboxText(line))
  if (lines.length === 0)
    out(`${PREFIX}the owner inbox is empty`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openBus(defaultBusPath())
  try {
    process.exitCode = runInbox(db, line => console.log(line))
  }
  finally {
    db.close()
  }
}
