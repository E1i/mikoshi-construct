import type { DatabaseSync } from 'node:sqlite'

export const POLICY_DENIED = 'policy.denied'
export const CARD_STOPPED = 'card.stopped'

const OWNER_INBOX = `
  SELECT id, type, card_id, pr, head, payload FROM events
  WHERE (type = '${POLICY_DENIED}' AND json_extract(payload, '$.kind') = 'authority')
     OR (type = '${CARD_STOPPED}' AND json_extract(payload, '$.reason') = 'question.owner')
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
