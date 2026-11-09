import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DECISIONS, readCurrent, staleLine } from './bus-readings.js'
import { CARD_BODIES } from './card-bodies.js'
import { CARD_BLOCKS, CLOSED_WAIT, defaultBusPath, openBus, OWNER_WAITS } from './db.js'
import { CARD_ADMITTED, CARD_STOPPED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, POLICY_DENIED, QUESTION_OWNER, SHARD_DECIDED, WINDOW_REQUEST } from './events.js'

export { RESTART_MISSED } from './events.js'
export const OWNER = 'owner'
export const ANSWER_SOURCE = 'answer'
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

function waitOpenedForTheStop(stop: string): string {
  return `(SELECT json_extract(opened.payload, '$.id') FROM events AS opened
      WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.legacy = 0 AND opened.card_id = ${stop}.card_id
        AND json_extract(opened.payload, '$.need') = 'decision' AND json_extract(opened.payload, '$.command') IS NOT NULL
        AND json_extract(opened.payload, '$.request') IS NULL AND json_extract(opened.payload, '$.pr') IS ${stop}.pr
        AND NOT EXISTS (
          SELECT 1 FROM ${OWNER_WAITS} AS earlier
          WHERE earlier.id = json_extract(opened.payload, '$.id') AND earlier.state = '${CLOSED_WAIT}' AND earlier.event_id < ${stop}.id
        )
      ORDER BY opened.id LIMIT 1)`
}

function answeredThroughTheOwnerChannel(stop: string): string {
  return `EXISTS (
      SELECT 1 FROM events AS closed
      JOIN events AS request ON request.id = json_extract(closed.payload, '$.request') AND request.type = '${WINDOW_REQUEST}'
      WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND closed.legacy = 0 AND closed.id > ${stop}.id
        AND json_extract(request.payload, '$.from') = '${ANSWER_SOURCE}'
        AND json_extract(closed.payload, '$.id') = ${waitOpenedForTheStop(stop)}
    )`
}

const NOT_PART_OF_A_NAME = '[^0-9A-Za-z_]'

function textNames(text: string, name: string): string {
  return `(' ' || ${text} || ' ') GLOB '*${NOT_PART_OF_A_NAME}' || ${name} || '${NOT_PART_OF_A_NAME}*'`
}

function admissionBefore(amend: string): string {
  return `(SELECT json_extract(prior.payload, '$.text') FROM events AS prior
      WHERE prior.type = '${CARD_ADMITTED}' AND prior.legacy = 0 AND prior.card_id = ${amend}.card_id AND prior.id < ${amend}.id
        AND json_type(prior.payload, '$.text') = 'text'
      ORDER BY prior.id DESC LIMIT 1)`
}

function namedAsTheAnswerByAnAmend(stop: string): string {
  return `EXISTS (
      SELECT 1 FROM events AS amend
      WHERE amend.type = '${CARD_ADMITTED}' AND amend.legacy = 0 AND amend.card_id = ${stop}.card_id AND amend.id > ${stop}.id
        AND EXISTS (
          SELECT 1 FROM (
            SELECT CAST(${stop}.id AS TEXT) AS name
            UNION ALL
            SELECT ${waitOpenedForTheStop(stop)}
          ) AS answered
          WHERE ${textNames(`coalesce(json_extract(amend.payload, '$.text'), '')`, 'answered.name')}
            AND NOT ${textNames(admissionBefore('amend'), 'answered.name')}
        )
    )`
}

export function ownerQuestionAnswered(stop: string): string {
  return `(EXISTS (
      SELECT 1 FROM decisions AS answer, json_each(answer.scope) AS named
      WHERE answer.event_id > ${stop}.id AND named.value = ${stop}.card_id
    ) OR ${everyBlockerMergedAfter(stop)} OR ${widenedByAnAmend(stop)} OR ${liftedByTheWindow(stop)} OR ${answeredThroughTheOwnerChannel(stop)} OR ${namedAsTheAnswerByAnAmend(stop)})`
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

const STALE_EXIT = 1

export function runInbox(db: DatabaseSync, out: (line: string) => void): number {
  const reading = readCurrent(db, [DECISIONS, OWNER_WAITS], () => ownerInbox(db))
  if (reading.stale !== null) {
    out(`${PREFIX}${staleLine(reading.stale)}`)
    return STALE_EXIT
  }
  const lines = reading.rows
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
