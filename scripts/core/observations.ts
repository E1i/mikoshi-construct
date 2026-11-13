import type { DatabaseSync } from 'node:sqlite'
import type { ChangedPaths, ClosedPr, MainHead, OpenPr, Snapshot } from '../ports/snapshot.js'
import type { BusEvent } from './db.js'
import type { StoredEvent } from './stored.js'
import { createHash } from 'node:crypto'
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

function observation(ts: string, type: string, fields: Pick<BusEvent, 'cardId' | 'pr' | 'head' | 'dedupeKey' | 'payload'>): BusEvent {
  return { ts, type, actor: NETWATCH, legacy: false, ...fields }
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

export function pathsOfTheLastObservation(previous: PreviousObservation | null, head: string): ChangedPaths | null {
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

function digestOf(payloadText: string): string {
  return createHash('sha256').update(payloadText).digest('hex')
}

function pathsFields(changed: ChangedPaths | undefined): { paths?: string[], pathsTruncated?: boolean } {
  return changed === undefined ? {} : { paths: changed.paths, pathsTruncated: changed.pathsTruncated }
}

export function prObserved(ts: string, open: OpenPr, previous: PreviousObservation | null): BusEvent {
  const payload = {
    card_id: open.cardId,
    base: open.base,
    head: open.head,
    ...(open.branch === null ? {} : { branch: open.branch }),
    mergeable: open.mergeable,
    ...open.ciFields,
    ...((open.cancelledChecks ?? []).length === 0 ? {} : { cancelled_checks: open.cancelledChecks }),
    ...(open.verdictOnHead === null ? {} : { verdict_on_head: open.verdictOnHead }),
    auto_merge: open.autoMerge,
    draft: open.draft,
    body_sha: open.bodySha,
    ...pathsFields(open.changed),
  }
  const digest = digestOf(JSON.stringify(payload))
  const repeatsPrevious = previous !== null && digestOf(previous.payload) === digest
  const dedupeKey = repeatsPrevious ? previous.dedupeKey : `pr:${open.pr}:${digest}:${previous?.id ?? '-'}`
  return observation(ts, 'pr.observed', { cardId: open.cardId, pr: open.pr, head: open.head, dedupeKey, payload })
}

export function prClosed(ts: string, closed: ClosedPr, reopening: number | null = null): BusEvent {
  const payload = {
    merged: closed.merged,
    ...(closed.branch == null ? {} : { branch: closed.branch }),
    ...(closed.commit === null ? {} : { commit: closed.commit }),
    ...(closed.mergedBy === null ? {} : { merged_by: closed.mergedBy }),
    ...(closed.mergedAt === null ? {} : { merged_at: closed.mergedAt }),
  }
  return observation(ts, PR_CLOSED, { cardId: closed.cardId, pr: closed.pr, head: null, dedupeKey: closedKey(closed.pr, reopening), payload })
}

export function mainAdvanced(ts: string, main: MainHead): BusEvent {
  return observation(ts, 'main.advanced', { cardId: null, pr: null, head: null, dedupeKey: `main:${main.sha}`, payload: { sha: main.sha, touches_mechanics: main.touchesMechanics, ...pathsFields(main.changed) } })
}

export function observationsOf(ts: string, snapshot: Snapshot, previousOf: PreviousObservationOf, reopening: ReopeningOf = () => null): BusEvent[] {
  return [
    ...snapshot.open.map(open => prObserved(ts, open, previousOf(open.pr))),
    ...snapshot.closed.map(closed => prClosed(ts, closed, reopening(closed.pr))),
    ...(snapshot.main === null ? [] : [mainAdvanced(ts, snapshot.main)]),
  ]
}

const LATEST_OBSERVATION_OF_THE_HEAD = `(SELECT max(seen.id) FROM events AS seen WHERE seen.type = '${PR_OBSERVED}' AND seen.pr = prs.pr AND seen.head = prs.head)`

const RED_ONLY_FROM_CANCELLED_CHECKS = `EXISTS (
    SELECT 1 FROM events AS observed WHERE observed.id = ${LATEST_OBSERVATION_OF_THE_HEAD}
      AND json_extract(observed.payload, '$.ci') = 'red'
      AND json_array_length(observed.payload, '$.failed_checks') > 0
      AND json_array_length(observed.payload, '$.cancelled_checks') = json_array_length(observed.payload, '$.failed_checks')
  )`

const ITS_RERUN_SPENT = `EXISTS (
    SELECT 1 FROM events AS rerun WHERE rerun.type = '${CI_RERUN_REQUESTED}' AND rerun.legacy = 0 AND rerun.pr = prs.pr AND rerun.head = prs.head
  )`

export const A_RERUN_DUE = `(${RED_ONLY_FROM_CANCELLED_CHECKS} AND NOT ${ITS_RERUN_SPENT})`

const CANCELLED_ONLY_TO_RERUN = `
  SELECT pr, card_id, head FROM prs
  WHERE state = 'open' AND ci = 'red' AND card_id IS NOT NULL AND head IS NOT NULL AND ${A_RERUN_DUE}
  ORDER BY pr
`

export interface HeadARerunIsDueOn {
  pr: number
  card_id: number
  head: string
}

interface HeadOfAPr {
  pr: number | null
  head: string | null
}

export function rerunDueOn(db: DatabaseSync, pr: number, head: string): boolean {
  return db.prepare(`SELECT 1 FROM prs WHERE pr = ? AND head = ? AND ci = 'red' AND ${A_RERUN_DUE}`).get(pr, head) !== undefined
}

export function withTheHeadsARerunIsDueOn<Row extends HeadOfAPr>(db: DatabaseSync, taken: Row[]): (Row | HeadARerunIsDueOn)[] {
  const due = db.prepare(CANCELLED_ONLY_TO_RERUN).all() as unknown as HeadARerunIsDueOn[]
  return [...taken, ...due.filter(row => !taken.some(each => each.pr === row.pr && each.head === row.head))]
}
