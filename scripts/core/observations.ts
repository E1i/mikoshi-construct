import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from './stored.js'
import { CI_RERUN_REQUESTED, declaredPart, PR_CLOSED, PR_OBSERVED } from './events.js'
import { payloadOf } from './stored.js'

export const NETWATCH = 'netwatch'

export const MACHINE_OVERLOADED = 'machine-overloaded'
export const MACHINE_OVERLOADED_MARK = 'машина перегружена'

const TIMED_OUT = /\btim(?:ed|es)?[ -]?out\b|таймаут/i
const UNDER_LOAD = /\b(?:over)?load(?:ed)?\b|нагрузк|перегруж/i
const NAMED_PATH = /[\w@.-]+(?:\/[\w@*.-]+)+/g
const TRAILING_DOTS = /\.+$/

function pathsNamedIn(question: string): string[] {
  return [...new Set((question.match(NAMED_PATH) ?? []).map(found => found.replace(TRAILING_DOTS, '')))]
}

export function timeoutUnderLoadOutside(question: string, outsideTouches: (paths: readonly string[]) => readonly string[]): boolean {
  const named = pathsNamedIn(question)
  return TIMED_OUT.test(question) && UNDER_LOAD.test(question) && named.length > 0 && outsideTouches(named).length === named.length
}

export function machineOverloadedLine(cardId: number, question: string): string {
  return `${MACHINE_OVERLOADED_MARK}: card #${cardId} timed out under machine load on a path outside its touches; that is a retry, not a card failure and not a question for the owner — the bus pushes the tree and CI judges: ${question}`
}

const OBSERVATION_AFTER_THE_LATEST_CLOSE = `
  SELECT min(id) AS id FROM events
  WHERE type = '${PR_OBSERVED}' AND pr = ?1 AND id > (SELECT max(id) FROM events WHERE type = '${PR_CLOSED}' AND pr = ?1)
`

export type ReopeningOf = (pr: number) => number | null

export function reopeningOf(db: DatabaseSync): ReopeningOf {
  return (pr) => {
    const row = db.prepare(OBSERVATION_AFTER_THE_LATEST_CLOSE).get(pr) as { id: number | null } | undefined
    return row?.id == null ? null : Number(row.id)
  }
}

export function closedKey(pr: number, reopening: number | null): string {
  return reopening === null ? `pr:${pr}:closed` : `pr:${pr}:closed:after-${reopening}`
}

export interface PreviousObservation {
  id: number
  dedupeKey: string
  payload: string
  event?: StoredEvent
}

const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value)
const nullableText = (value: unknown): string | null => value == null ? null : String(value)

export function previousObservationOf(row: Readonly<Record<string, unknown>>): PreviousObservation {
  const event: StoredEvent = { id: Number(row.id), ts: String(row.ts), type: String(row.type), card_id: nullableNumber(row.card_id), pr: nullableNumber(row.pr), head: nullableText(row.head), dedupe_key: String(row.dedupe_key), payload: String(row.payload) }
  return { id: event.id, dedupeKey: event.dedupe_key, payload: event.payload, event }
}

export interface ObservedPaths {
  paths: string[]
  pathsTruncated: boolean
}

export function pathsOfTheLastObservation(previous: PreviousObservation | null, head: string): ObservedPaths | null {
  const event = previous?.event
  if (event === undefined || event.type !== PR_OBSERVED || event.head !== head)
    return null
  const payload = declaredPart(PR_OBSERVED, payloadOf(event))
  const paths = payload.paths
  if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string'))
    return null
  return { paths, pathsTruncated: payload.pathsTruncated === true }
}

export type PreviousObservationOf = (pr: number) => PreviousObservation | null

function latestObservationOfTheHead(row: string): string {
  return `(SELECT max(seen.id) FROM events AS seen WHERE seen.type = '${PR_OBSERVED}' AND seen.pr = ${row}.pr AND seen.head = ${row}.head)`
}

function redOnlyFromCancelledChecks(row: string): string {
  return `EXISTS (
    SELECT 1 FROM events AS observed WHERE observed.id = ${latestObservationOfTheHead(row)}
      AND json_extract(observed.payload, '$.ci') = 'red'
      AND json_array_length(observed.payload, '$.failed_checks') > 0
      AND json_array_length(observed.payload, '$.cancelled_checks') = json_array_length(observed.payload, '$.failed_checks')
  )`
}

function itsRerunSpent(row: string): string {
  return `EXISTS (
    SELECT 1 FROM events AS rerun WHERE rerun.type = '${CI_RERUN_REQUESTED}' AND rerun.legacy = 0 AND rerun.pr = ${row}.pr AND rerun.head = ${row}.head
  )`
}

function aRerunDueOnTheRow(row: string): string {
  return `(${redOnlyFromCancelledChecks(row)} AND NOT ${itsRerunSpent(row)})`
}

export const A_RERUN_DUE = aRerunDueOnTheRow('prs')

const A_RERUN_DUE_ON_THE_HEAD = `SELECT 1 FROM (SELECT ? AS pr, ? AS head) AS pull WHERE ${aRerunDueOnTheRow('pull')}`

export interface HeadARerunIsDueOn {
  pr: number
  card_id: number
  head: string
}

export interface PullOnCi {
  pr: number
  card_id: number | null
  head: string | null
  state: string | null
  ci: string | null
}

interface HeadOfAPr {
  pr: number | null
  head: string | null
}

function dueOnTheHead(db: DatabaseSync, pr: number, head: string): boolean {
  return db.prepare(A_RERUN_DUE_ON_THE_HEAD).get(pr, head) !== undefined
}

export function rerunDueOn(db: DatabaseSync, pull: PullOnCi | null, head: string): boolean {
  return pull !== null && pull.head === head && pull.ci === 'red' && dueOnTheHead(db, pull.pr, head)
}

function redOpenHeadOfACard(pull: PullOnCi): HeadARerunIsDueOn[] {
  return pull.state === 'open' && pull.ci === 'red' && pull.card_id !== null && pull.head !== null ? [{ pr: pull.pr, card_id: pull.card_id, head: pull.head }] : []
}

export function withTheHeadsARerunIsDueOn<Row extends HeadOfAPr>(db: DatabaseSync, pulls: readonly PullOnCi[], taken: Row[]): (Row | HeadARerunIsDueOn)[] {
  const due = pulls.flatMap(redOpenHeadOfACard).filter(row => dueOnTheHead(db, row.pr, row.head)).sort((a, b) => a.pr - b.pr)
  return [...taken, ...due.filter(row => !taken.some(each => each.pr === row.pr && each.head === row.head))]
}
