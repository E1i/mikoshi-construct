import type { DatabaseSync } from 'node:sqlite'
import type { BoundDecision } from '../core/identifiers.js'
import type { CandidateRules, Derived, MayRequeue, QuestionAnswered, QueuedTask, QueueSource, RequeueRow, TaskRow } from '../core/queue.js'
import { NOT_A_BACKFILL } from '../core/backfill-source.js'
import { appendEvent, inTransaction, OPEN_WAIT, openOwnerWait, OWNER_WAITS } from '../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, declaredPart, MERGE_DONE, OWNER_WAIT_OPENED, POLICY_DENIED, PR_CLOSED, PR_OPENED, QUESTION_OWNER, REVIEW_ROUNDS_SPENT, ROUND_MUTATIONS_PARKED, TASK_FAILED, TASK_REQUEUED, TASK_WITHDRAWN } from '../core/events.js'
import { tasksTheHeadOrTheCardDecisionSupersedes } from '../core/identifiers.js'
import { ADMIT_COMMAND } from '../core/owner-commands.js'
import { A_LAUNCH_STOP_WITH_NO_PULL_REQUEST, ADMITTED_AFTER_THE_STOP, aDowngradeWaitOpenOn, anOpenQuestion, answersOfAnOldCardBody, ASKS_TO_WIDEN_THE_TOUCHES, candidateRows, COMPLETED, deriveQueues, DOWNGRADE_WAIT_OPEN, everyRow, FAILURES_TO_STOP, FAULT, identityOfRow, keyOf, latestQuestionStops, latestTurnOf, LEASED, openCandidates, QUEUE_ACTOR, QUEUED, reviewsOfAnOldInput, reviewsOfTheCurrentInputAgain, STOPPED, SUPERSEDED, supersedeTask, THE_WINDOW_AMENDS_THE_CARD_FIRST, UNFINISHED_STATES, WITHDRAWN, withdrawTask } from '../core/queue.js'

export const LIFTED_ADMISSION = 'lifted'
export const RECUT_GRACE_MS = 10 * 60 * 1000
const NO_CARD_TREE = 'no_card_tree'

export interface QueuePass {
  sources: readonly QueueSource[]
  mayRequeue: MayRequeue
  decisionsAt: (db: DatabaseSync, ts: string) => readonly BoundDecision[]
  held: <T>(db: DatabaseSync, ts: string, work: () => T) => T
}

const LAST_MECHANICS = `SELECT sha, event_id FROM mains WHERE touches_mechanics = 1 ORDER BY event_id DESC LIMIT 1`

const RESTART_TARGETS = `
  WITH mechanics AS (${LAST_MECHANICS}), readings AS (
    SELECT chains.dir, chains.card_id, chains.sha, chains.state, mechanics.sha AS mechanics_sha,
      mechanics.sha IS NOT NULL AND chains.sha NOT IN (SELECT sha FROM mains WHERE event_id >= mechanics.event_id) AS behind
    FROM chains LEFT JOIN mechanics ON 1
  )
  SELECT dir, card_id, CASE WHEN behind THEN mechanics_sha ELSE sha END AS head FROM readings
  WHERE state != 'stopped' AND (behind OR state = 'fault')
`

const RESTART_CANDIDATES = `SELECT NULL AS pr, card_id, head FROM (${RESTART_TARGETS}) ORDER BY dir`

const A_CLOSE_DENIED_ON_THIS_WITNESS = `EXISTS (SELECT 1 FROM events AS denied WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.card_id = tasks.card_id AND denied.head = tasks.head AND json_extract(denied.payload, '$.reason') = 'witness' AND json_extract(denied.payload, '$.command') = 'close' AND instr(tasks.task_key, ':base-' || json_extract(denied.payload, '$.base')) > 0)`

const TASKS_OF_AN_OLD_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.head != prs.head AS head_moved FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.state IN (${UNFINISHED_STATES}) AND tasks.head IS NOT NULL AND (tasks.head != prs.head OR tasks.queue IN ('merge', 'update'))
    AND NOT (tasks.queue = 'answer' AND tasks.state = '${LEASED}')
  UNION
  SELECT task_key, queue, card_id, pr, head, 1 AS head_moved FROM tasks
  WHERE queue = 'restart' AND state IN ('${QUEUED}', '${LEASED}')
    AND head NOT IN (SELECT targets.head FROM (${RESTART_TARGETS}) AS targets WHERE targets.card_id = tasks.card_id)
  ORDER BY task_key
`

const MERGES_OF_AN_OLD_BODY = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'merge' AND tasks.state IN ('${QUEUED}', '${LEASED}') AND tasks.head = prs.head
    AND prs.body_sha IS NOT NULL AND instr(tasks.task_key || ':', ':pr-body-' || prs.body_sha || ':') = 0
  ORDER BY tasks.task_key
`

const A_MERGED_CARD_STILL_NEEDS_IT = `(tasks.queue IN ('merge', 'close', 'witness') AND tasks.state = '${LEASED}' AND tasks.lease_until >= ?) OR (NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${CARD_CLOSED}' AND closed.card_id = tasks.card_id) AND (tasks.queue = 'close' OR (tasks.queue = 'witness' AND ${A_CLOSE_DENIED_ON_THIS_WITNESS})))`

const TASKS_OF_A_CLOSED_PULL_REQUEST = `SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.state IN (${UNFINISHED_STATES}) AND (prs.state = 'closed' OR (prs.state = 'merged' AND NOT (${A_MERGED_CARD_STILL_NEEDS_IT})))
  ORDER BY tasks.task_key`

const SUPERSEDED_MERGES_AND_UPDATES_ON_THE_CURRENT_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue IN ('merge', 'update') AND tasks.state = '${SUPERSEDED}' AND tasks.head = prs.head AND prs.state = 'open'
    AND NOT EXISTS (SELECT 1 FROM tasks AS live WHERE live.queue = tasks.queue AND live.pr = tasks.pr AND live.state IN ('${QUEUED}', '${LEASED}'))
  ORDER BY tasks.task_key
`

const CAUSE_GONE_ON: Record<string, string> = {
  no_verification: `gone.type = '${CARD_VERIFIED}' AND gone.legacy = 0`,
  no_merge_commit: `(gone.type = '${MERGE_DONE}' OR (gone.type = '${PR_CLOSED}' AND json_extract(gone.payload, '$.merged') = 1))`,
}

const CAUSE_OF_THE_STOP = `json_extract(stop.payload, '$.reason')`

const A_CAUSE_GONE = `CASE ${CAUSE_OF_THE_STOP} ${Object.entries(CAUSE_GONE_ON).map(([cause, gone]) => `WHEN '${cause}' THEN ${gone}`).join(' ')} ELSE 0 END`

const ATTEMPTS_ON_THE_CAUSE = `(
  SELECT count(*) FROM events AS again WHERE again.type = '${TASK_REQUEUED}'
    AND json_extract(again.payload, '$.task_key') = tasks.task_key AND json_extract(again.payload, '$.cause') = ${CAUSE_OF_THE_STOP}
)`

const ALARMS_WHOSE_CAUSE_IS_GONE = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, min(gone.id) AS failure, ${CAUSE_OF_THE_STOP} AS cause FROM tasks
  JOIN events AS stop ON stop.id = tasks.event_id
  JOIN events AS gone ON gone.id > stop.id AND gone.card_id = tasks.card_id AND gone.pr IS tasks.pr AND ${A_CAUSE_GONE}
  LEFT JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.state = '${STOPPED}'
    AND EXISTS (SELECT 1 FROM events AS alarm WHERE alarm.type = '${BOARD_ALARM}' AND json_extract(alarm.payload, '$.task_key') = tasks.task_key)
    AND (tasks.pr IS NULL OR (prs.state IS NOT 'closed' AND prs.head = tasks.head))
    AND ${ATTEMPTS_ON_THE_CAUSE} < ${FAILURES_TO_STOP}
  GROUP BY tasks.task_key
  ORDER BY tasks.task_key
`

const CARD_TREE_CAN_BE_BROUGHT_UP = `(
  EXISTS (SELECT 1 FROM prs AS open WHERE open.card_id = tasks.card_id AND open.state = 'open')
  OR EXISTS (
    SELECT 1 FROM events AS start WHERE start.card_id = tasks.card_id
      AND ((start.type = '${CARD_STARTED}' AND start.legacy = 0) OR (start.type = 'path' AND start.legacy = 1))
      AND json_type(start.payload, '$.worktree') = 'text' AND json_type(start.payload, '$.branch') = 'text'
  )
)`

const STOPPED_ON_NO_CARD_TREE = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, failure.id AS failure FROM tasks
  JOIN events AS failure ON failure.id = tasks.event_id
  LEFT JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'answer' AND tasks.state = '${STOPPED}' AND json_extract(failure.payload, '$.reason') = '${NO_CARD_TREE}'
    AND (tasks.pr IS NULL OR (prs.state = 'open' AND prs.head = tasks.head))
    AND ${CARD_TREE_CAN_BE_BROUGHT_UP}
  ORDER BY tasks.task_key
`

function answersWhoseStopNoLongerHolds(answered: QuestionAnswered): string {
  return `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.failures, stop.id AS failure,
    json_extract(stop.payload, '$.reason') = '${FAULT}' AS fault FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  JOIN events AS stop ON stop.dedupe_key = '${CARD_STOPPED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.queue = 'answer' AND tasks.state = '${COMPLETED}' AND tasks.task_key NOT LIKE '%:stop-%'
    AND prs.state = 'open' AND prs.head = tasks.head
    AND stop.id = ${latestTurnOf('tasks.card_id')}
    AND json_extract(stop.payload, '$.reason') IN ('${FAULT}', '${QUESTION_OWNER}') AND NOT ${anOpenQuestion(answered)}
  ORDER BY tasks.task_key
`
}

const QUEUED_ANSWERS_UNDER_A_DOWNGRADE_WAIT = `
  SELECT task_key, queue, card_id, pr, head FROM tasks
  WHERE queue = 'answer' AND state = '${QUEUED}' AND ${aDowngradeWaitOpenOn('tasks.card_id')}
  ORDER BY task_key
`

const ANSWERS_PARKED_ON_A_DOWNGRADE_WAIT_NOW_CLOSED = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  LEFT JOIN prs ON prs.pr = tasks.pr
  JOIN events AS parked ON parked.id = tasks.event_id
  WHERE tasks.queue = 'answer' AND tasks.state = '${WITHDRAWN}' AND (tasks.pr IS NULL OR (prs.state = 'open' AND prs.head = tasks.head))
    AND parked.type IN ('${TASK_FAILED}', '${TASK_WITHDRAWN}') AND json_extract(parked.payload, '$.reason') = '${DOWNGRADE_WAIT_OPEN}'
    AND NOT ${aDowngradeWaitOpenOn('tasks.card_id')}
  ORDER BY tasks.task_key
`

const A_QUESTION_OF_THE_STOP_STILL_OPEN = `EXISTS (
  SELECT 1 FROM events AS opened WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.legacy = 0 AND opened.card_id = stop.card_id AND opened.id > stop.id
    AND NOT EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS settled WHERE settled.id = json_extract(opened.payload, '$.id') AND settled.state != '${OPEN_WAIT}')
)`

const LAUNCH_STOPS_LIFTED = latestQuestionStops(
  `stop.card_id, stop.id AS stop, (
    SELECT admitted.payload FROM events AS admitted WHERE admitted.type = '${CARD_ADMITTED}' AND admitted.legacy = 0 AND admitted.card_id = stop.card_id
      AND ${NOT_A_BACKFILL}
    ORDER BY admitted.id DESC LIMIT 1
  ) AS admission`,
  `${A_LAUNCH_STOP_WITH_NO_PULL_REQUEST} AND NOT ${ASKS_TO_WIDEN_THE_TOUCHES} AND NOT ${ADMITTED_AFTER_THE_STOP} AND NOT ${A_QUESTION_OF_THE_STOP_STILL_OPEN} AND coalesce(cards.state NOT IN ('closed', 'dropped'), 1)`,
)

const QUESTIONS_WITH_NO_WINDOW_WAIT_YET = latestQuestionStops(
  `stop.card_id, coalesce(stop.pr, cards.pr) AS pr, ${ASKS_TO_WIDEN_THE_TOUCHES} AS widen, json_extract(stop.payload, '$.detail') AS detail,
    (SELECT json_extract(admitted.payload, '$.lane') FROM events AS admitted WHERE admitted.type = '${CARD_ADMITTED}' AND admitted.legacy = 0 AND admitted.card_id = stop.card_id ORDER BY admitted.id DESC LIMIT 1) AS lane`,
  `${THE_WINDOW_AMENDS_THE_CARD_FIRST}
    AND NOT EXISTS (SELECT 1 FROM events AS opened WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.card_id = stop.card_id AND opened.id > stop.id)`,
)

const ROUND_LIMITS_WITH_NO_OUTCOME = `
  SELECT spent.card_id, spent.pr FROM events AS spent JOIN prs ON prs.pr = spent.pr
  WHERE spent.type = '${REVIEW_ROUNDS_SPENT}' AND spent.legacy = 0 AND spent.ts <= ? AND prs.state = 'open'
    AND NOT EXISTS (SELECT 1 FROM events AS opened WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.pr = spent.pr AND opened.id > spent.id)
    AND NOT EXISTS (SELECT 1 FROM events AS recut WHERE recut.type = '${PR_OPENED}' AND json_extract(recut.payload, '$.recut_of') = spent.pr)
    AND NOT EXISTS (SELECT 1 FROM events AS parked WHERE parked.type = '${ROUND_MUTATIONS_PARKED}' AND parked.legacy = 0 AND parked.pr = spent.pr)
  ORDER BY spent.pr
`

interface WindowQuestionRow {
  card_id: number
  pr: number | null
  widen: number
  detail: unknown
  lane: unknown
}

interface StoppedAnswerRow extends TaskRow {
  failure: number
  failures: number
  fault: number
}

export function admitCommandOf(cardId: number, lane: unknown): string {
  return `${ADMIT_COMMAND} <parking>${typeof lane === 'string' && lane !== '' ? `/${lane}` : ''}/${cardId}.md`
}

function windowWaitText(row: WindowQuestionRow): string {
  const question = typeof row.detail === 'string' && row.detail !== '' ? row.detail : 'no detail'
  const why = row.widen === 1 ? 'asks to widen its touches' : 'asked the same question twice in a row'
  return `card #${row.card_id} ${why}: ${question}; the window amends the card, and the answer goes on after its card.admitted`
}

export function lostRecutWaitText(cardId: number, pr: number): string {
  return `card #${cardId}: PR #${pr} reached the review round limit (D-104), and the bus holds neither its re-cut nor an owner wait for it; check whether it was re-cut before deciding it`
}

function openLostRecutWaits(db: DatabaseSync, ts: string): void {
  const settled = new Date(Date.parse(ts) - RECUT_GRACE_MS).toISOString()
  for (const row of db.prepare(ROUND_LIMITS_WITH_NO_OUTCOME).all(settled) as { card_id: number, pr: number }[])
    inTransaction(db, () => openOwnerWait(db, ts, QUEUE_ACTOR, { need: 'decision', text: lostRecutWaitText(row.card_id, row.pr), card: row.card_id, pr: row.pr }))
}

function openWindowWaits(db: DatabaseSync, ts: string): void {
  for (const row of db.prepare(QUESTIONS_WITH_NO_WINDOW_WAIT_YET).all() as unknown as WindowQuestionRow[])
    inTransaction(db, () => openOwnerWait(db, ts, QUEUE_ACTOR, { need: 'command', text: windowWaitText(row), command: admitCommandOf(row.card_id, row.lane), card: row.card_id, ...(row.pr === null ? {} : { pr: row.pr }) }))
}

function readmitLiftedLaunchStops(db: DatabaseSync, ts: string): void {
  for (const row of db.prepare(LAUNCH_STOPS_LIFTED).all() as { card_id: number, stop: number, admission: string | null }[]) {
    if (row.admission === null)
      continue
    const admission = `${LIFTED_ADMISSION}:${row.stop}`
    const payload = { ...declaredPart(CARD_ADMITTED, JSON.parse(row.admission) as object), admission }
    inTransaction(db, () => appendEvent(db, { ts, type: CARD_ADMITTED, actor: QUEUE_ACTOR, cardId: row.card_id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${admission}`, payload, legacy: false }))
  }
}

function alarmed(db: DatabaseSync, ts: string, row: StoppedAnswerRow): void {
  const failures = row.failures + 1
  const detail = `${failures} failures in a row on ${row.task_key}, the last a ${FAULT} stop`
  appendEvent(db, { ts, type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${BOARD_ALARM}:${row.task_key}`, payload: { task_key: row.task_key, reason: FAULT, failures, detail }, legacy: false })
}

function rowsOf(db: DatabaseSync, query: string): RequeueRow[] {
  return db.prepare(query).all() as unknown as RequeueRow[]
}

export const NO_CARD_TREE_SOURCE: QueueSource = { queue: 'answer', requeue: db => rowsOf(db, STOPPED_ON_NO_CARD_TREE) }

export const DOWNGRADE_PARKED_SOURCE: QueueSource = { queue: 'answer', requeue: db => rowsOf(db, ANSWERS_PARKED_ON_A_DOWNGRADE_WAIT_NOW_CLOSED) }

export function dueAgainSource(candidates: (db: DatabaseSync, ts: string) => QueuedTask[]): QueueSource {
  return {
    requeue: (db, ts) => {
      const due = new Set(candidates(db, ts).map(keyOf))
      return [...reviewsOfTheCurrentInputAgain(db), ...rowsOf(db, SUPERSEDED_MERGES_AND_UPDATES_ON_THE_CURRENT_HEAD).filter(row => due.has(row.task_key))]
    },
  }
}

export function causeGoneSource(reopened: (db: DatabaseSync, ts: string) => RequeueRow[]): QueueSource {
  return { requeue: (db, ts) => [...rowsOf(db, ALARMS_WHOSE_CAUSE_IS_GONE), ...reopened(db, ts)] }
}

export function stopNoLongerHoldsSource(answered: QuestionAnswered): QueueSource {
  const query = answersWhoseStopNoLongerHolds(answered)
  return {
    queue: 'answer',
    requeue: (db, ts) => (db.prepare(query).all() as unknown as StoppedAnswerRow[]).flatMap((row): RequeueRow[] => {
      const fault = row.fault === 1
      if (fault && row.failures + 1 >= FAILURES_TO_STOP) {
        alarmed(db, ts, row)
        return []
      }
      return [{ ...row, fault }]
    }),
  }
}

export const SETTLE_SOURCE: QueueSource = {
  settle: (db, ts) => {
    for (const row of db.prepare(QUEUED_ANSWERS_UNDER_A_DOWNGRADE_WAIT).all() as unknown as TaskRow[])
      withdrawTask(db, ts, identityOfRow(row), DOWNGRADE_WAIT_OPEN)
    openWindowWaits(db, ts)
    readmitLiftedLaunchStops(db, ts)
    openLostRecutWaits(db, ts)
  },
}

export function restartSource(rules: CandidateRules): QueueSource {
  return { queue: 'restart', enqueue: (db, ts) => openCandidates(db, ts, 'restart', candidateRows(db, RESTART_CANDIDATES, everyRow), rules) }
}

function supersededAndWithdrawn(db: DatabaseSync, ts: string, pass: QueuePass): string[] {
  const superseded: string[] = []
  for (const row of tasksTheHeadOrTheCardDecisionSupersedes(db.prepare(TASKS_OF_AN_OLD_HEAD).all() as unknown as (TaskRow & { head_moved: number })[], pass.decisionsAt(db, ts), identityOfRow)) {
    if (supersedeTask(db, ts, identityOfRow(row)))
      superseded.push(row.task_key)
  }
  for (const row of db.prepare(TASKS_OF_A_CLOSED_PULL_REQUEST).all(ts) as unknown as TaskRow[])
    withdrawTask(db, ts, identityOfRow(row))
  for (const row of [...reviewsOfAnOldInput(db), ...answersOfAnOldCardBody(db), ...db.prepare(MERGES_OF_AN_OLD_BODY).all() as unknown as TaskRow[]]) {
    if (supersedeTask(db, ts, identityOfRow(row)))
      superseded.push(row.task_key)
  }
  return superseded
}

export function derivedQueues(db: DatabaseSync, ts: string, pass: QueuePass): Derived {
  return pass.held(db, ts, () => {
    const superseded = supersededAndWithdrawn(db, ts, pass)
    const derived = deriveQueues(db, ts, pass.sources, pass.mayRequeue)
    return { queued: derived.queued, superseded: [...superseded, ...derived.superseded] }
  })
}
