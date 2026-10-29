import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_BODIES } from './card-bodies.js'
import { CARD_BLOCKS, defaultBusPath, openBus } from './db.js'
import { CARD_STOPPED, POLICY_DENIED, QUESTION_OWNER, SHARD_DECIDED } from './events.js'

export const RESTART_MISSED = 'supervisor.restart_missed'
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

const TOUCHES_PREFIX_SUFFIX = '/**'
const PREFIX_KEPT = TOUCHES_PREFIX_SUFFIX.length - 1

function withinAmendedTouches(amended: string, wanted: string): string {
  return `EXISTS (SELECT 1 FROM json_each(coalesce(${amended}.touches, '[]')) AS touched
      WHERE touched.value = ${wanted}.value
        OR (substr(touched.value, -${TOUCHES_PREFIX_SUFFIX.length}) = '${TOUCHES_PREFIX_SUFFIX}'
          AND substr(${wanted}.value, 1, length(touched.value) - ${PREFIX_KEPT}) = substr(touched.value, 1, length(touched.value) - ${PREFIX_KEPT})))`
}

function createdByTheAmend(amended: string, wanted: string): string {
  return `EXISTS (SELECT 1 FROM json_each(coalesce(${amended}.creates, '[]')) AS created
      WHERE trim(created.value) = ${wanted}.value OR substr(trim(created.value), 1, length(${wanted}.value) + 2) = ${wanted}.value || ' (')`
}

function widenedByAnAmend(stop: string): string {
  return `(coalesce(json_array_length(${stop}.payload, '$.widen'), 0) > 0
    AND EXISTS (
      SELECT 1 FROM ${CARD_BODIES} AS amended
      WHERE amended.card_id = ${stop}.card_id AND amended.admission_event_id > ${stop}.id
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${stop}.payload, '$.widen') AS wanted
          WHERE NOT ${withinAmendedTouches('amended', 'wanted')} AND NOT ${createdByTheAmend('amended', 'wanted')}
        )
    ))`
}

function liftedByTheWindow(stop: string): string {
  return `EXISTS (
      SELECT 1 FROM events AS lifted
      WHERE lifted.type = '${SHARD_DECIDED}' AND lifted.legacy = 0 AND lifted.card_id = ${stop}.card_id AND lifted.id > ${stop}.id
        AND json_extract(lifted.payload, '$.stop') = ${stop}.id
    )`
}

export function ownerQuestionAnswered(stop: string): string {
  return `(EXISTS (
      SELECT 1 FROM decisions AS answer, json_each(answer.scope) AS named
      WHERE answer.event_id > ${stop}.id AND named.value = ${stop}.card_id
    ) OR ${everyBlockerMergedAfter(stop)} OR ${widenedByAnAmend(stop)} OR ${liftedByTheWindow(stop)})`
}

export const OPEN_OWNER_STOP_OF_CARD = `
  SELECT id, payload FROM events AS stop
  WHERE stop.legacy = 0 AND stop.type = '${CARD_STOPPED}' AND stop.card_id = ?
    AND json_extract(stop.payload, '$.reason') = '${QUESTION_OWNER}' AND NOT ${ownerQuestionAnswered('stop')}
  ORDER BY id DESC LIMIT 1
`

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
