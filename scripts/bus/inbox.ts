import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_BLOCKS, defaultBusPath, openBus } from './db.js'

export const POLICY_DENIED = 'policy.denied'
export const CARD_STOPPED = 'card.stopped'
export const CARD_STARTED = 'card.started'
export const CARD_ANSWERED = 'card.answered'
export const DECISION_RECORDED = 'decision.recorded'
export const QUESTION_OWNER = 'question.owner'
export const OWNER = 'owner'
export const PREFIX = '[bus:inbox] '

function blocksIn(event: string): string {
  return `coalesce(json_extract(${event}.payload, '$.card.blocks'), ${CARD_BLOCKS}(json_extract(${event}.payload, '$.card')))`
}

function latestBlocksOf(card: string): string {
  return `(SELECT ${blocksIn('line')} FROM events AS line
      WHERE line.card_id = ${card} AND ${blocksIn('line')} IS NOT NULL ORDER BY line.id DESC LIMIT 1)`
}

function blockersOf(stop: string): string {
  return `SELECT DISTINCT named.card_id FROM events AS named
      WHERE named.card_id IS NOT NULL AND named.payload LIKE '%#' || ${stop}.card_id || '%'
        AND EXISTS (SELECT 1 FROM json_each(${latestBlocksOf('named.card_id')}) AS blocked WHERE blocked.value = ${stop}.card_id)`
}

function everyBlockerMergedAfter(stop: string): string {
  return `(EXISTS (
      SELECT 1 FROM (${blockersOf(stop)}) AS blocking
      JOIN prs AS blocker ON blocker.card_id = blocking.card_id AND blocker.state = 'merged' AND blocker.event_id > ${stop}.id
    ) AND NOT EXISTS (
      SELECT 1 FROM (${blockersOf(stop)}) AS waiting
      WHERE NOT EXISTS (SELECT 1 FROM prs AS merged WHERE merged.card_id = waiting.card_id AND merged.state = 'merged')
    ))`
}

export function ownerQuestionAnswered(stop: string): string {
  return `(EXISTS (
      SELECT 1 FROM decisions AS answer, json_each(answer.scope) AS named
      WHERE answer.event_id > ${stop}.id AND named.value = ${stop}.card_id
    ) OR ${everyBlockerMergedAfter(stop)})`
}

const OWNER_INBOX = `
  SELECT id, type, card_id, pr, head, payload FROM events AS item
  WHERE item.legacy = 0 AND (
    (item.type = '${POLICY_DENIED}' AND json_extract(item.payload, '$.kind') = 'authority')
    OR (item.type = '${CARD_STOPPED}' AND json_extract(item.payload, '$.reason') = '${QUESTION_OWNER}' AND NOT ${ownerQuestionAnswered('item')})
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
