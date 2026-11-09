import type { DatabaseSync } from 'node:sqlite'
import type { ClosedPr, MainHead, OpenPr, Snapshot } from '../ports/snapshot.js'
import type { BusEvent } from './db.js'
import { createHash } from 'node:crypto'
import { CI_RERUN_REQUESTED, PR_CLOSED, PR_OBSERVED } from './events.js'

export const NETWATCH = 'netwatch'

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
}

export type PreviousObservationOf = (pr: number) => PreviousObservation | null

function digestOf(payloadText: string): string {
  return createHash('sha256').update(payloadText).digest('hex')
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
  return observation(ts, 'main.advanced', { cardId: null, pr: null, head: null, dedupeKey: `main:${main.sha}`, payload: { sha: main.sha, touches_mechanics: main.touchesMechanics } })
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
