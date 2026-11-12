import type { DatabaseSync } from 'node:sqlite'
import type { RerunMode } from '../cli/check-catalog.js'
import type { OverlapCatch } from '../nodes/launch/launch-candidates.js'
import type { MutationParking } from '../policy/round-limit-decision.js'
import type { BusEvent } from './db.js'
import type { Queue, TaskIdentity } from './identifiers.js'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { PRIORITIES, WINDOW_WHO } from '../../src/card/parking.js'
import { AMEND_SOURCE, witnessesOf } from '../../src/commands/intake/admit.js'
import { launchCandidates } from '../nodes/launch/launch-candidates.js'
import { cleanUpdatesOf } from '../nodes/update/update-done.js'
import { continueFixesDecisionOf, mutationsParkedGrantOf, observedHeadsOf, pushedAfterContinueFixes, roundLimitDecisionOf, sameFindings } from '../policy/round-limit-decision.js'
import { DECISIONS_SCOPE, decisionsInForceAt, unspentShardsOf, WINDOW_SHARDS_LIVE_AT } from '../policy/shards.js'
import { MAIN_BRANCH } from '../ports/snapshot.js'
import { BACKFILL_SOURCE, NOT_A_BACKFILL } from './backfill-source.js'
import { CARD_BODIES } from './card-bodies.js'
import { answerDecisionOfKey, decisionSegment, withDecidedContinuations } from './card-decisions.js'
import { appendEvent, inTransaction, OPEN_WAIT, openOwnerWait, OWNER_WAITS } from './db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, CARD_WAITING, declaredPart, INTAKE_EVENT, INTAKE_MOVE_EVENT, MERGE_DONE, OWNER_WAIT_OPENED, POLICY_DENIED, PR_CLOSED, PR_OBSERVED, PR_OPENED, QUESTION_AGENT, QUESTION_OWNER, REVIEW_RECORDED, REVIEW_ROUNDS_SPENT, ROUND_EXTENDED, ROUND_MUTATIONS_PARKED, SESSION_HEARTBEAT, SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED, TASK_COMPLETED, TASK_ENQUEUED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_RENEWED, TASK_REQUEUED, TASK_SUPERSEDED, TASK_WITHDRAWN, UPDATE_DONE, WITNESS_DOWNGRADE, WITNESS_RECORDED } from './events.js'
import { generationOfKey, isFullSha, QUEUES, reviewInputOf, reviewInputOfKey, taskKey } from './identifiers.js'
import { ownerQuestionAnswered } from './inbox.js'
import { A_RERUN_DUE, withTheHeadsARerunIsDueOn } from './observations.js'
import { ADMIT_COMMAND } from './owner-commands.js'
import { payloadOf, reject } from './stored.js'
import { markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const LEASE_MS = 30 * 60_000
export const SESSION_HELD_QUEUES: readonly Queue[] = ['review']
export const QUEUE_ACTOR = 'policy'
export const FAILURES_TO_STOP = 3
export const REVIEW_ROUNDS = 3

export const QUEUED = 'queued'
export const LEASED = 'leased'
export const WITHDRAWN = 'withdrawn'
export const COMPLETED = 'completed'
export const STOPPED = 'stopped'
const SUPERSEDED = 'superseded'
const FAULT = 'fault'
const REQUEUABLE = new Set([STOPPED, WITHDRAWN, SUPERSEDED])
const REQUEUABLE_AFTER_COMPLETION = new Set([...REQUEUABLE, COMPLETED])
const UNFINISHED = new Set([QUEUED, LEASED, STOPPED])
const AFTER_A_LEASE = new Set([QUEUED, WITHDRAWN, STOPPED])
const NO_CARD_TREE = 'no_card_tree'
const [TOP_PRIORITY] = PRIORITIES

function latestBodyAdmission(card: string, columns: string): string {
  return `
    SELECT ${columns} FROM events AS intake
    WHERE intake.card_id = ${card} AND json_type(intake.payload, '$.bodySha') = 'text'
      AND ((intake.legacy = 1 AND intake.type IN ('${INTAKE_EVENT}', '${INTAKE_MOVE_EVENT}')) OR (intake.legacy = 0 AND intake.type = '${CARD_ADMITTED}'))
    ORDER BY intake.id DESC LIMIT 1
  `
}

function cardBodyShaOf(card: string): string {
  return `(${latestBodyAdmission(card, `json_extract(intake.payload, '$.bodySha')`)})`
}

const REVIEWED_UNDER_AN_INPUT = `EXISTS (
  SELECT 1 FROM tasks AS reviewed WHERE reviewed.queue = 'review' AND reviewed.pr = prs.pr AND reviewed.head = prs.head AND reviewed.task_key LIKE '%:pr-body-%'
)`

const A_REVIEW_UNDER_A_PLAIN_KEY = `EXISTS (
  SELECT 1 FROM tasks AS plain WHERE plain.queue = 'review' AND plain.pr = prs.pr AND plain.head = prs.head
    AND plain.state != '${SUPERSEDED}' AND plain.task_key NOT LIKE '%:pr-body-%'
)`

const REVIEW_CANDIDATES = `
  SELECT pr, card_id, head, body_sha, ${cardBodyShaOf('prs.card_id')} AS card_body FROM prs
  WHERE state = 'open' AND ci = 'green' AND card_id IS NOT NULL AND head IS NOT NULL
    AND (verdict_on_head IS NULL OR (verdict_on_head IN ('changes', 'pass') AND body_sha IS NOT NULL AND ${REVIEWED_UNDER_AN_INPUT}))
    AND NOT ${A_REVIEW_UNDER_A_PLAIN_KEY}
  ORDER BY pr
`

const SUPERSEDED_REVIEWS_ON_THE_CURRENT_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure, prs.body_sha, ${cardBodyShaOf('tasks.card_id')} AS card_body FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'review' AND tasks.state = '${SUPERSEDED}' AND tasks.head = prs.head AND prs.state = 'open'
    AND prs.ci = 'green' AND (prs.verdict_on_head IS NULL OR prs.verdict_on_head = 'changes')
    AND prs.body_sha IS NOT NULL AND tasks.task_key LIKE '%:pr-body-%'
    AND NOT EXISTS (SELECT 1 FROM tasks AS live WHERE live.queue = 'review' AND live.pr = tasks.pr AND live.state IN ('queued', 'leased'))
  ORDER BY tasks.task_key
`

const SUPERSEDED_MERGES_AND_UPDATES_ON_THE_CURRENT_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue IN ('merge', 'update') AND tasks.state = '${SUPERSEDED}' AND tasks.head = prs.head AND prs.state = 'open'
    AND NOT EXISTS (SELECT 1 FROM tasks AS live WHERE live.queue = tasks.queue AND live.pr = tasks.pr AND live.state IN ('${QUEUED}', '${LEASED}'))
  ORDER BY tasks.task_key
`

const REVIEWS_OF_AN_OLD_INPUT = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, prs.body_sha, ${cardBodyShaOf('tasks.card_id')} AS card_body FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'review' AND tasks.state IN ('queued', 'leased') AND tasks.head = prs.head
    AND prs.body_sha IS NOT NULL AND tasks.task_key LIKE '%:pr-body-%'
  ORDER BY tasks.task_key
`

const LIVE_ANSWERS_WITH_THE_CARD_BODY = `
  SELECT task_key, queue, card_id, pr, head, state, ${cardBodyShaOf('tasks.card_id')} AS card_body FROM tasks
  WHERE queue = 'answer' AND state IN ('${QUEUED}', '${LEASED}')
  ORDER BY task_key
`

const A_SUPERSEDED_ANSWER_WITHIN_ITS_LEASE = `
  SELECT 1 FROM tasks
  WHERE queue = 'answer' AND state = '${SUPERSEDED}' AND card_id = ? AND lease_until > ?
  LIMIT 1
`

const LATEST_ADMISSION_DEPENDS = `
  SELECT depends.value AS card_id FROM json_each((
    SELECT admitted.payload FROM events AS admitted
    WHERE admitted.legacy = 0 AND admitted.type = '${CARD_ADMITTED}' AND admitted.card_id = prs.card_id
      AND json_extract(admitted.payload, '$.source') IS NOT '${BACKFILL_SOURCE}'
    ORDER BY admitted.id DESC LIMIT 1
  ), '$.depends') AS depends
  WHERE depends.type = 'integer'
`

const A_DEPENDENCY_UNMERGED = `EXISTS (
  SELECT 1 FROM (${LATEST_ADMISSION_DEPENDS}) AS dependency
  WHERE NOT EXISTS (SELECT 1 FROM events AS done WHERE done.type = '${MERGE_DONE}' AND done.legacy = 0 AND done.card_id = dependency.card_id)
    AND NOT EXISTS (SELECT 1 FROM prs AS merged WHERE merged.card_id = dependency.card_id AND merged.state = 'merged')
    AND NOT EXISTS (SELECT 1 FROM events AS legacy WHERE legacy.type = 'merge' AND legacy.legacy = 1 AND legacy.card_id = dependency.card_id)
)`

const A_REVIEW_IN_FLIGHT = `EXISTS (
  SELECT 1 FROM tasks AS reviewing WHERE reviewing.queue = 'review' AND reviewing.pr = prs.pr AND reviewing.head = prs.head
    AND reviewing.state IN ('${QUEUED}', '${LEASED}')
)`

function mergeCandidatesWhere(verdict: string, mergeable: string): string {
  return `
  SELECT pr, card_id, head, body_sha FROM prs
  WHERE state = 'open' AND base = '${MAIN_BRANCH}' AND ci = 'green' AND ${verdict} AND ${mergeable} AND draft = 0 AND card_id IS NOT NULL AND head IS NOT NULL
    AND NOT ${A_DEPENDENCY_UNMERGED} AND NOT ${A_REVIEW_IN_FLIGHT}
  ORDER BY pr
`
}

export const MERGE_CANDIDATES = mergeCandidatesWhere(`verdict_on_head = 'pass'`, `mergeable = 'clean'`)

export const MERGE_CANDIDATES_WITHOUT_PASS = mergeCandidatesWhere(`verdict_on_head IS NOT 'pass'`, `mergeable IN ('clean', 'blocked')`)

export const MERGE_CANDIDATES_BEHIND = mergeCandidatesWhere(`verdict_on_head = 'pass'`, `mergeable = 'behind'`)

export const NEEDS_UPDATE = 'needs_update'

export const MERGE_REFUSED = 'merge_refused'

export const QUESTION_OPEN = 'owner_question_open'

export function openDecisionWaitsOf(card: string): string {
  return `SELECT id, text FROM ${OWNER_WAITS} WHERE need = 'decision' AND state = '${OPEN_WAIT}' AND card_id = ${card}`
}

const MERGES_PARKED_ON_A_QUESTION_NOW_CLOSED = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  JOIN events AS parked ON parked.id = tasks.event_id
  WHERE tasks.queue = 'merge' AND tasks.state = '${WITHDRAWN}' AND prs.state = 'open' AND prs.head = tasks.head
    AND parked.type = '${TASK_FAILED}' AND json_extract(parked.payload, '$.reason') = '${QUESTION_OPEN}'
    AND NOT EXISTS (${openDecisionWaitsOf('tasks.card_id')})
  ORDER BY tasks.task_key
`

const GREEN_BEHIND_BY_CARD_PRIORITY = `
  SELECT prs.pr, prs.card_id, prs.head, prs.verdict_on_head FROM prs
  LEFT JOIN ${CARD_BODIES} AS body ON body.card_id = prs.card_id
  WHERE prs.state = 'open' AND prs.base = '${MAIN_BRANCH}' AND prs.mergeable = 'behind' AND prs.draft = 0 AND prs.card_id IS NOT NULL AND prs.head IS NOT NULL
    AND prs.ci = 'green'
  ORDER BY body.priority IS NOT '${TOP_PRIORITY}', prs.pr
`

export const AN_UPDATED_PR_HOLDS_MS = LEASE_MS

const UPDATED_AND_ON_ITS_WAY_TO_MERGE = `
  SELECT DISTINCT prs.pr, prs.card_id, prs.head, prs.verdict_on_head, updated.ts AS updated_at FROM prs
  JOIN events AS updated ON updated.type = '${UPDATE_DONE}' AND updated.legacy = 0 AND updated.pr = prs.pr
    AND prs.head IN (json_extract(updated.payload, '$.from'), json_extract(updated.payload, '$.to'))
    AND json_extract(updated.payload, '$.carried') = 'pass' AND json_type(updated.payload, '$.task_key') = 'text'
    AND updated.ts > ?
  WHERE prs.state = 'open' AND prs.base = '${MAIN_BRANCH}' AND prs.draft = 0 AND prs.card_id IS NOT NULL AND prs.head IS NOT NULL
    AND prs.verdict_on_head = 'pass' AND prs.ci IS NOT 'red' AND prs.mergeable IS NOT 'dirty'
    AND NOT ${A_DEPENDENCY_UNMERGED}
    AND NOT EXISTS (
      SELECT 1 FROM tasks AS parked WHERE parked.queue = 'merge' AND parked.pr = prs.pr AND parked.head = prs.head
        AND parked.state IN ('${WITHDRAWN}', '${STOPPED}')
    )
`

const AN_ANSWER_IN_FLIGHT = `EXISTS (
  SELECT 1 FROM tasks AS answering WHERE answering.queue = 'answer' AND answering.card_id = prs.card_id
    AND answering.state IN ('${QUEUED}', '${LEASED}')
)`

const CONFLICTING_BY_CARD_PRIORITY = `
  SELECT prs.pr, prs.card_id, prs.head, prs.verdict_on_head FROM prs
  LEFT JOIN ${CARD_BODIES} AS body ON body.card_id = prs.card_id
  WHERE prs.state = 'open' AND prs.base = '${MAIN_BRANCH}' AND prs.mergeable = 'dirty' AND prs.draft = 0 AND prs.card_id IS NOT NULL AND prs.head IS NOT NULL
    AND NOT ${AN_ANSWER_IN_FLIGHT}
  ORDER BY body.priority IS NOT '${TOP_PRIORITY}', prs.pr
`

const GREEN_CLEAN_A_MERGE_SENT_TO_UPDATE = `
  SELECT prs.pr, prs.card_id, prs.head, prs.verdict_on_head, (SELECT max(denied.id) FROM events AS denied WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.pr = prs.pr
    AND denied.head = prs.head AND json_extract(denied.payload, '$.command') = 'merge' AND json_extract(denied.payload, '$.reason') = '${NEEDS_UPDATE}') AS sent_at FROM prs
  LEFT JOIN ${CARD_BODIES} AS body ON body.card_id = prs.card_id
  WHERE prs.state = 'open' AND prs.base = '${MAIN_BRANCH}' AND prs.mergeable = 'clean' AND prs.draft = 0 AND prs.card_id IS NOT NULL AND prs.head IS NOT NULL AND prs.ci = 'green' AND sent_at IS NOT NULL
  ORDER BY body.priority IS NOT '${TOP_PRIORITY}', prs.pr
`

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

const VERIFIED_ON_ITS_OWN_OR_A_SHARED_PR = `verified.type = '${CARD_VERIFIED}' AND verified.legacy = 0 AND verified.pr = prs.pr AND verified.card_id IS NOT NULL
  AND (verified.card_id = prs.card_id OR json_type(verified.payload, '$.sharedBy') = 'text')`

const CLOSE_CANDIDATES = `
  SELECT DISTINCT prs.pr, verified.card_id, prs.head FROM prs
  JOIN events AS verified ON ${VERIFIED_ON_ITS_OWN_OR_A_SHARED_PR}
  WHERE prs.state = 'merged' AND prs.card_id IS NOT NULL AND prs.head IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM events WHERE events.type = '${CARD_CLOSED}' AND events.card_id = verified.card_id)
  ORDER BY prs.pr, verified.card_id
`

const WITNESS_CANDIDATES_ON_NO_RECORD = `
  SELECT pr, card_id, head, ${cardBodyShaOf('prs.card_id')} AS card_body, NULL AS witness_base FROM prs
  WHERE state = 'open' AND base = '${MAIN_BRANCH}' AND draft = 0 AND card_id IS NOT NULL AND head IS NOT NULL
    AND ${cardBodyShaOf('prs.card_id')} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events AS recorded WHERE recorded.type = '${WITNESS_RECORDED}' AND recorded.legacy = 0
        AND recorded.card_id = prs.card_id AND recorded.head = prs.head
        AND json_extract(recorded.payload, '$.cardBody') = ${cardBodyShaOf('prs.card_id')}
    )
  ORDER BY pr
`

const WITNESS_CANDIDATES_ON_MAIN = `
  SELECT NULL AS pr, body.card_id, (SELECT sha FROM mains ORDER BY event_id DESC LIMIT 1) AS head, ${cardBodyShaOf('body.card_id')} AS card_body, NULL AS witness_base, body.text
  FROM ${CARD_BODIES} AS body
  WHERE EXISTS (SELECT 1 FROM mains)
    AND ${cardBodyShaOf('body.card_id')} IS NOT NULL
    AND EXISTS (SELECT 1 FROM events AS started WHERE started.type = '${CARD_STARTED}' AND started.legacy = 0 AND started.card_id = body.card_id)
    AND NOT EXISTS (SELECT 1 FROM prs WHERE prs.card_id = body.card_id)
    AND NOT EXISTS (SELECT 1 FROM cards WHERE cards.card_id = body.card_id AND cards.state IN ('closed', 'dropped', 'merged'))
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${CARD_CLOSED}' AND closed.card_id = body.card_id)
    AND NOT EXISTS (
      SELECT 1 FROM events AS recorded WHERE recorded.type = '${WITNESS_RECORDED}' AND recorded.legacy = 0
        AND recorded.card_id = body.card_id AND recorded.pr IS NULL
        AND json_extract(recorded.payload, '$.cardBody') = ${cardBodyShaOf('body.card_id')}
    )
  ORDER BY body.card_id
`

const LATEST_WITNESS_DENIAL = `
  SELECT max(latest.id) FROM events AS latest
  WHERE latest.type = '${POLICY_DENIED}' AND latest.legacy = 0 AND latest.card_id = denied.card_id AND latest.head = denied.head
    AND json_extract(latest.payload, '$.reason') = 'witness'
`

const WITNESS_CANDIDATES_ON_A_DENIED_BASE = `
  SELECT denied.pr, denied.card_id, denied.head, ${cardBodyShaOf('denied.card_id')} AS card_body, json_extract(denied.payload, '$.base') AS witness_base FROM events AS denied
  WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.pr IS NOT NULL AND denied.card_id IS NOT NULL AND denied.head IS NOT NULL
    AND json_extract(denied.payload, '$.reason') = 'witness' AND json_type(denied.payload, '$.base') = 'text'
    AND denied.id = (${LATEST_WITNESS_DENIAL})
    AND ${cardBodyShaOf('denied.card_id')} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events AS recorded WHERE recorded.type = '${WITNESS_RECORDED}' AND recorded.legacy = 0
        AND recorded.card_id = denied.card_id AND recorded.head = denied.head
        AND json_extract(recorded.payload, '$.cardBody') = ${cardBodyShaOf('denied.card_id')}
        AND json_extract(recorded.payload, '$.base') = json_extract(denied.payload, '$.base')
    )
  ORDER BY denied.id
`

const WITHDRAWN_ON_A_WITNESS_NOW_GREEN = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  WHERE tasks.queue IN ('merge', 'close') AND tasks.state = '${WITHDRAWN}' AND tasks.head IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM events AS denied
      JOIN events AS green ON green.type = '${WITNESS_RECORDED}' AND green.legacy = 0 AND green.card_id = denied.card_id AND green.head = denied.head
      WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.card_id = tasks.card_id AND denied.head = tasks.head
        AND json_extract(denied.payload, '$.reason') = 'witness' AND json_extract(denied.payload, '$.command') = tasks.queue
        AND denied.id = (${LATEST_WITNESS_DENIAL} AND json_extract(latest.payload, '$.command') = tasks.queue)
        AND green.id > tasks.event_id AND json_extract(green.payload, '$.verdict') = 'green'
        AND json_extract(green.payload, '$.base') = json_extract(denied.payload, '$.base')
    )
    AND (tasks.queue = 'close' OR EXISTS (SELECT 1 FROM prs WHERE prs.pr = tasks.pr AND prs.state = 'open' AND prs.head = tasks.head))
  ORDER BY tasks.task_key
`

const CARD_TURNS = `'${CARD_STOPPED}', '${CARD_ANSWERED}', '${CARD_STARTED}'`

export function latestTurnOf(card: string): string {
  return `(SELECT id FROM events AS turn WHERE turn.card_id = ${card} AND turn.legacy = 0 AND turn.type IN (${CARD_TURNS}) ORDER BY turn.id DESC LIMIT 1)`
}

const ASKS_TO_WIDEN_THE_TOUCHES = `EXISTS (
  SELECT 1 FROM json_each(stop.payload, '$.widen') AS widen WHERE widen.type = 'text' AND widen.value != ''
)`

const THE_TURN_BEFORE_THE_STOP = `(
  SELECT id FROM events AS turn WHERE turn.card_id = stop.card_id AND turn.legacy = 0 AND turn.type IN (${CARD_TURNS}) AND turn.id < stop.id
  ORDER BY turn.id DESC LIMIT 1
)`

const ASKED_THE_SAME_QUESTION_JUST_BEFORE = `EXISTS (
  SELECT 1 FROM events AS before WHERE before.id = ${THE_TURN_BEFORE_THE_STOP} AND before.type = '${CARD_STOPPED}'
    AND json_extract(before.payload, '$.reason') = '${QUESTION_AGENT}'
    AND json_extract(before.payload, '$.detail') IS json_extract(stop.payload, '$.detail')
)`

const ADMITTED_AFTER_THE_STOP = `EXISTS (
  SELECT 1 FROM events AS admitted WHERE admitted.type = '${CARD_ADMITTED}' AND admitted.legacy = 0 AND admitted.card_id = stop.card_id AND admitted.id > stop.id
)`

const THE_WINDOW_AMENDS_THE_CARD_FIRST = `((${ASKS_TO_WIDEN_THE_TOUCHES} OR ${ASKED_THE_SAME_QUESTION_JUST_BEFORE}) AND NOT ${ADMITTED_AFTER_THE_STOP})`

export const LAUNCH_STOP_WITH_NO_PULL_REQUEST = `${CARD_STOPPED}:no-pull-request:`

const A_LAUNCH_STOP_WITH_NO_PULL_REQUEST = `(stop.pr IS NULL AND substr(stop.dedupe_key, 1, ${LAUNCH_STOP_WITH_NO_PULL_REQUEST.length}) = '${LAUNCH_STOP_WITH_NO_PULL_REQUEST}')`

const A_QUESTION_OF_THE_STOP_STILL_OPEN = `EXISTS (
  SELECT 1 FROM events AS opened WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.legacy = 0 AND opened.card_id = stop.card_id AND opened.id > stop.id
    AND NOT EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS settled WHERE settled.id = json_extract(opened.payload, '$.id') AND settled.state != '${OPEN_WAIT}')
)`

function latestQuestionStops(columns: string, condition: string): string {
  return `
  SELECT ${columns} FROM events AS stop
  LEFT JOIN cards ON cards.card_id = stop.card_id
  LEFT JOIN prs ON prs.pr = coalesce(stop.pr, cards.pr)
  WHERE stop.type = '${CARD_STOPPED}' AND stop.legacy = 0 AND stop.card_id IS NOT NULL
    AND json_extract(stop.payload, '$.reason') = '${QUESTION_AGENT}'
    AND stop.id = ${latestTurnOf('stop.card_id')}
    AND (prs.pr IS NULL OR prs.state = 'open')
    AND ${condition}
  ORDER BY stop.card_id
`
}

export const DOWNGRADE_WAIT_OPEN = 'downgrade_wait_open'

function aDowngradeWaitOpenOn(card: string): string {
  return `EXISTS (
    SELECT 1 FROM ${OWNER_WAITS} AS wait JOIN events AS asked ON asked.id = wait.event_id
    WHERE wait.card_id = ${card} AND wait.state = '${OPEN_WAIT}' AND asked.type = '${CARD_WAITING}'
      AND json_extract(asked.payload, '$.reason') = '${WITNESS_DOWNGRADE}'
  )`
}

const A_DOWNGRADE_WAIT_OF_THE_CARD = `SELECT ${aDowngradeWaitOpenOn('?')} AS open`

export function downgradeWaitOpenOn(db: DatabaseSync, cardId: number): boolean {
  return (db.prepare(A_DOWNGRADE_WAIT_OF_THE_CARD).get(cardId) as { open: number }).open === 1
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

const QUESTION_CANDIDATES = latestQuestionStops(
  `stop.card_id, coalesce(stop.pr, cards.pr) AS pr, coalesce(prs.head, stop.head) AS head, stop.id AS stop, ${cardBodyShaOf('stop.card_id')} AS card_body`,
  `NOT ${THE_WINDOW_AMENDS_THE_CARD_FIRST} AND NOT ${A_LAUNCH_STOP_WITH_NO_PULL_REQUEST} AND ${notAWindowCard('stop.card_id')} AND NOT ${aDowngradeWaitOpenOn('stop.card_id')}`,
)

const LAUNCH_STOPS_LIFTED = latestQuestionStops(
  `stop.card_id, stop.id AS stop, (
    SELECT admitted.payload FROM events AS admitted WHERE admitted.type = '${CARD_ADMITTED}' AND admitted.legacy = 0 AND admitted.card_id = stop.card_id
      AND ${NOT_A_BACKFILL}
    ORDER BY admitted.id DESC LIMIT 1
  ) AS admission`,
  `${A_LAUNCH_STOP_WITH_NO_PULL_REQUEST} AND NOT ${ASKS_TO_WIDEN_THE_TOUCHES} AND NOT ${ADMITTED_AFTER_THE_STOP} AND NOT ${A_QUESTION_OF_THE_STOP_STILL_OPEN}`,
)

export const LIFTED_ADMISSION = 'lifted'

function readmitLiftedLaunchStops(db: DatabaseSync, ts: string): void {
  for (const row of db.prepare(LAUNCH_STOPS_LIFTED).all() as { card_id: number, stop: number, admission: string | null }[]) {
    if (row.admission === null)
      continue
    const admission = `${LIFTED_ADMISSION}:${row.stop}`
    const payload = { ...declaredPart(CARD_ADMITTED, JSON.parse(row.admission) as object), admission }
    inTransaction(db, () => appendEvent(db, { ts, type: CARD_ADMITTED, actor: QUEUE_ACTOR, cardId: row.card_id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${admission}`, payload, legacy: false }))
  }
}

const QUESTIONS_WITH_NO_WINDOW_WAIT_YET = latestQuestionStops(
  `stop.card_id, coalesce(stop.pr, cards.pr) AS pr, ${ASKS_TO_WIDEN_THE_TOUCHES} AS widen, json_extract(stop.payload, '$.detail') AS detail,
    (SELECT json_extract(admitted.payload, '$.lane') FROM events AS admitted WHERE admitted.type = '${CARD_ADMITTED}' AND admitted.legacy = 0 AND admitted.card_id = stop.card_id ORDER BY admitted.id DESC LIMIT 1) AS lane`,
  `${THE_WINDOW_AMENDS_THE_CARD_FIRST}
    AND NOT EXISTS (SELECT 1 FROM events AS opened WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.card_id = stop.card_id AND opened.id > stop.id)`,
)

interface WindowQuestionRow {
  card_id: number
  pr: number | null
  widen: number
  detail: unknown
  lane: unknown
}

export function admitCommandOf(cardId: number, lane: unknown): string {
  return `${ADMIT_COMMAND} <parking>${typeof lane === 'string' && lane !== '' ? `/${lane}` : ''}/${cardId}.md`
}

function windowWaitText(row: WindowQuestionRow): string {
  const question = typeof row.detail === 'string' && row.detail !== '' ? row.detail : 'no detail'
  const why = row.widen === 1 ? 'asks to widen its touches' : 'asked the same question twice in a row'
  return `card #${row.card_id} ${why}: ${question}; the window amends the card, and the answer goes on after its card.admitted`
}

export const RECUT_GRACE_MS = 10 * 60 * 1000

const ROUND_LIMITS_WITH_NO_OUTCOME = `
  SELECT spent.card_id, spent.pr FROM events AS spent JOIN prs ON prs.pr = spent.pr
  WHERE spent.type = '${REVIEW_ROUNDS_SPENT}' AND spent.legacy = 0 AND spent.ts <= ? AND prs.state = 'open'
    AND NOT EXISTS (SELECT 1 FROM events AS opened WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.pr = spent.pr AND opened.id > spent.id)
    AND NOT EXISTS (SELECT 1 FROM events AS recut WHERE recut.type = '${PR_OPENED}' AND json_extract(recut.payload, '$.recut_of') = spent.pr)
    AND NOT EXISTS (SELECT 1 FROM events AS parked WHERE parked.type = '${ROUND_MUTATIONS_PARKED}' AND parked.legacy = 0 AND parked.pr = spent.pr)
  ORDER BY spent.pr
`

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

const AN_OPEN_QUESTION = `(
  json_extract(stop.payload, '$.reason') = '${QUESTION_AGENT}'
  OR (json_extract(stop.payload, '$.reason') = '${QUESTION_OWNER}' AND NOT ${ownerQuestionAnswered('stop')})
)`

function notAWindowCard(card: string): string {
  return `NOT EXISTS (SELECT 1 FROM ${CARD_BODIES} AS body WHERE body.card_id = ${card} AND body.who = '${WINDOW_WHO}')`
}

function answerCandidatesWhere(condition: string): string {
  return `
  SELECT pr, card_id, head, ${cardBodyShaOf('prs.card_id')} AS card_body FROM prs
  WHERE state = 'open' AND ${condition} AND card_id IS NOT NULL AND head IS NOT NULL
    AND ${notAWindowCard('prs.card_id')}
    AND NOT ${aDowngradeWaitOpenOn('prs.card_id')}
    AND NOT EXISTS (
      SELECT 1 FROM events AS stop WHERE stop.id = ${latestTurnOf('prs.card_id')}
        AND stop.type = '${CARD_STOPPED}' AND ${AN_OPEN_QUESTION}
    )
  ORDER BY pr
`
}

const CHANGES_CANDIDATES = answerCandidatesWhere(`verdict_on_head = 'changes'`)

const RED_CI_CANDIDATES = answerCandidatesWhere(`ci = 'red' AND NOT ${A_RERUN_DUE}`)

const DIRTY_THE_UPDATE_COULD_NOT_MERGE = answerCandidatesWhere(`base = '${MAIN_BRANCH}' AND mergeable = 'dirty' AND draft = 0 AND EXISTS (
    SELECT 1 FROM events AS refused WHERE refused.type = '${POLICY_DENIED}' AND refused.legacy = 0 AND refused.pr = prs.pr AND refused.head = prs.head
      AND json_extract(refused.payload, '$.reason') = '${MERGE_REFUSED}'
  )`)

const RED_WITNESS_CANDIDATES = answerCandidatesWhere(`EXISTS (
    SELECT 1 FROM events AS red WHERE red.id = (
      SELECT max(latest.id) FROM events AS latest WHERE latest.type = '${WITNESS_RECORDED}' AND latest.legacy = 0 AND latest.pr = prs.pr AND latest.head = prs.head
    ) AND json_extract(red.payload, '$.verdict') = 'red'
  )`)

interface Candidate {
  pr: number | null
  card_id: number
  head: string | null
  verdict_on_head?: string | null
  stop?: number | null
  body_sha?: string | null
  card_body?: unknown
  witness_base?: string | null
  text?: unknown
}

export const REVIEWS_OF_A_PR = `
  SELECT head, json_extract(payload, '$.verdict') AS verdict, json_extract(payload, '$.card_body') AS card_body FROM events
  WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? ORDER BY id
`

export interface RoundReview {
  head: string | null
  verdict: unknown
  card_body: unknown
}

export const BODIES_OWNER_AMENDED_FOR_A_PR = `
  SELECT DISTINCT json_extract(payload, '$.bodySha') AS body FROM events
  WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND json_extract(payload, '$.source') = '${AMEND_SOURCE}' AND json_type(payload, '$.bodySha') = 'text'
    AND card_id IN (SELECT card_id FROM events WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? AND card_id IS NOT NULL)
`

function bodyThePreviousHeadWasFirstReviewedUnder(reviews: readonly RoundReview[], at: number): unknown {
  const earlier = reviews.slice(0, at).filter(review => review.head !== reviews[at]!.head)
  const previous = earlier.at(-1)
  return previous === undefined ? null : earlier.find(review => review.head === previous.head)!.card_body
}

export function ownerAmendedSinceThePreviousReview(reviews: readonly RoundReview[], at: number, ownerAmended: ReadonlySet<string>): boolean {
  const before = bodyThePreviousHeadWasFirstReviewedUnder(reviews, at)
  const now = reviews[at]!.card_body
  return typeof before === 'string' && typeof now === 'string' && before !== now && ownerAmended.has(now)
}

export function roundsOf(reviews: readonly RoundReview[], ownerAmended: ReadonlySet<string>): number {
  const heads = new Set<string | null>()
  let rounds = 0
  for (const [at, review] of reviews.entries()) {
    if (review.verdict !== 'changes' || heads.has(review.head))
      continue
    heads.add(review.head)
    if (!ownerAmendedSinceThePreviousReview(reviews, at, ownerAmended))
      rounds += 1
  }
  return rounds
}

export { activeDecisionsShard } from '../policy/shards.js'
export const REPEAT_FINDINGS = 'repeat_findings'
const REPEAT_STOP_ON_A_HEAD = `SELECT 1 FROM events WHERE type = '${REVIEW_ROUNDS_SPENT}' AND legacy = 0 AND pr = ? AND head IS ? AND json_extract(payload, '$.state') = '${REPEAT_FINDINGS}' LIMIT 1`

const A_WINDOW_DECISIONS_SHARD_LIVE_AT_THE_EXTENSION = `EXISTS (
  SELECT 1 FROM events AS issued
  WHERE issued.type = '${SHARD_ISSUED}' AND issued.id < extended.id AND json_extract(issued.payload, '$.window') = 1
    AND json_extract(issued.payload, '$.scope') = '${DECISIONS_SCOPE}' AND json_extract(issued.payload, '$.until') > extended.ts
    AND NOT EXISTS (
      SELECT 1 FROM events AS ended WHERE ended.type IN ('${SHARD_REVOKED}', '${SHARD_EXPIRED}') AND ended.id < extended.id
        AND json_extract(ended.payload, '$.id') = json_extract(issued.payload, '$.id')
    )
)`

const GREEN_CI_ON_THE_EXTENDED_HEAD = `EXISTS (
  SELECT 1 FROM events AS seen
  WHERE seen.id = (SELECT max(latest.id) FROM events AS latest WHERE latest.type = '${PR_OBSERVED}' AND latest.legacy = 0 AND latest.pr = extended.pr AND latest.id < extended.id)
    AND seen.head = extended.head AND json_extract(seen.payload, '$.ci') = 'green'
)`

const GRANTED_EXTENSIONS_OF_A_PR = `
  SELECT json_extract(extended.payload, '$.findings') AS findings, json_extract(extended.payload, '$.previous') AS previous FROM events AS extended
  WHERE extended.type = '${ROUND_EXTENDED}' AND extended.legacy = 0 AND extended.pr = ?
    AND ${A_WINDOW_DECISIONS_SHARD_LIVE_AT_THE_EXTENSION} AND ${GREEN_CI_ON_THE_EXTENDED_HEAD}
`

function findingsIn(json: string | null): string[] {
  const parsed: unknown = json === null ? [] : JSON.parse(json)
  return Array.isArray(parsed) ? parsed.filter((finding): finding is string => typeof finding === 'string') : []
}

function raisesNewFindings(row: { findings: string | null, previous: string | null }): boolean {
  const findings = findingsIn(row.findings)
  return findings.length > 0 && !sameFindings(findings, findingsIn(row.previous))
}

function extensionsOf(db: DatabaseSync, pr: number): number {
  return (db.prepare(GRANTED_EXTENSIONS_OF_A_PR).all(pr) as { findings: string | null, previous: string | null }[]).filter(raisesNewFindings).length
}

export function changesRoundsOf(db: DatabaseSync, pr: number, next?: RoundReview): number {
  const ownerAmended = new Set((db.prepare(BODIES_OWNER_AMENDED_FOR_A_PR).all(pr) as { body: string }[]).map(row => row.body))
  const counted = [...db.prepare(REVIEWS_OF_A_PR).all(pr) as unknown as RoundReview[], ...(next === undefined ? [] : [next])]
  const rounds = roundsOf(counted, ownerAmended) - extensionsOf(db, pr)
  return db.prepare(REPEAT_STOP_ON_A_HEAD).get(pr, counted.at(-1)?.head ?? null) === undefined ? rounds : Math.max(rounds, REVIEW_ROUNDS)
}

const ROUND_LIMITED: readonly Queue[] = ['review', 'answer', 'merge']

function outOfRounds(db: DatabaseSync, queue: Queue, pr: number | null): boolean {
  return ROUND_LIMITED.includes(queue) && pr !== null && changesRoundsOf(db, pr) >= REVIEW_ROUNDS
}

const MUTATION_PARKINGS_OF_A_PR = `SELECT id, head FROM events WHERE type = '${ROUND_MUTATIONS_PARKED}' AND legacy = 0 AND pr = ? AND head IS NOT NULL ORDER BY id`

function mutationParkingsOf(db: DatabaseSync, pr: number): MutationParking[] {
  return db.prepare(MUTATION_PARKINGS_OF_A_PR).all(pr) as unknown as MutationParking[]
}

export function mergeDecidedPastRoundLimit(db: DatabaseSync, ts: string, pr: number | null, head: string | null): number | null {
  if (pr === null || head === null || !outOfRounds(db, 'merge', pr))
    return null
  const cleanUpdates = cleanUpdatesOf(db, pr)
  return roundLimitDecisionOf(decisionsInForceAt(db, new Date(ts)), pr, head, cleanUpdates) ?? mutationsParkedGrantOf(mutationParkingsOf(db, pr), head, cleanUpdates)
}

const CHANGES_HEADS_OF_A_PR = `SELECT DISTINCT head FROM events WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? AND head IS NOT NULL AND json_extract(payload, '$.verdict') = 'changes'`

function continuedPastRoundLimit(db: DatabaseSync, ts: string, queue: Queue, pr: number, head: string | null): boolean {
  if (head === null)
    return false
  const decisions = decisionsInForceAt(db, new Date(ts))
  const cleanUpdates = cleanUpdatesOf(db, pr)
  if (queue === 'answer')
    return continueFixesDecisionOf(decisions, pr, head, cleanUpdates) !== null
  const changesHeads = new Set((db.prepare(CHANGES_HEADS_OF_A_PR).all(pr) as { head: string }[]).map(row => row.head))
  return pushedAfterContinueFixes(decisions, pr, head, { observedHeads: observedHeadsOf(db, pr), cleanUpdates, changesHeads })
}

export function closedByRounds(db: DatabaseSync, ts: string, queue: Queue, pr: number | null, head: string | null): boolean {
  if (pr === null || !outOfRounds(db, queue, pr))
    return false
  if (queue === 'merge' && mergeDecidedPastRoundLimit(db, ts, pr, head) !== null)
    return false
  return !continuedPastRoundLimit(db, ts, queue, pr, head)
}

type Admits = (row: Candidate) => boolean

const everyRow: Admits = () => true

const namesWitnesses: Admits = row => typeof row.text === 'string' && witnessesOf(row.text).length > 0

function aMergeCandidate(db: DatabaseSync, ts: string): Admits {
  const decided = decidedPastRoundLimit(db, ts)
  return row => (row.verdict_on_head === 'pass' || decided(row)) && !closedByRounds(db, ts, 'merge', row.pr, row.head)
}

function decidedPastRoundLimit(db: DatabaseSync, ts: string): Admits {
  return row => mergeDecidedPastRoundLimit(db, ts, row.pr, row.head) !== null
}

function candidateRows(db: DatabaseSync, query: string, admits: Admits): Candidate[] {
  return (db.prepare(query).all() as unknown as Candidate[]).filter(admits)
}

function mergeRows(db: DatabaseSync, ts: string, rerun: RerunMode): Candidate[] {
  const behind = rerun === 'by-layers' ? candidateRows(db, MERGE_CANDIDATES_BEHIND, everyRow) : []
  return [...candidateRows(db, MERGE_CANDIDATES, everyRow), ...behind, ...candidateRows(db, MERGE_CANDIDATES_WITHOUT_PASS, decidedPastRoundLimit(db, ts))]
}

function candidates(db: DatabaseSync, ts: string): (() => QueuedTask[])[] {
  const open = (queue: Queue, query: string, admits: Admits = everyRow): (() => QueuedTask[]) => () => openCandidates(db, ts, queue, candidateRows(db, query, admits))
  return [
    open('restart', RESTART_CANDIDATES),
    () => answerCandidates(db, ts),
  ]
}

const UNFINISHED_STATES = [...UNFINISHED].map(state => `'${state}'`).join(', ')

const A_CLOSE_DENIED_ON_THIS_WITNESS = `EXISTS (SELECT 1 FROM events AS denied WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.card_id = tasks.card_id AND denied.head = tasks.head AND json_extract(denied.payload, '$.reason') = 'witness' AND json_extract(denied.payload, '$.command') = 'close' AND instr(tasks.task_key, ':base-' || json_extract(denied.payload, '$.base')) > 0)`

const TASKS_OF_AN_OLD_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.state IN (${UNFINISHED_STATES}) AND tasks.head IS NOT NULL AND tasks.head != prs.head
    AND NOT (tasks.queue = 'answer' AND tasks.state = '${LEASED}')
  UNION
  SELECT task_key, queue, card_id, pr, head FROM tasks
  WHERE queue = 'restart' AND state IN ('${QUEUED}', '${LEASED}')
    AND head NOT IN (SELECT targets.head FROM (${RESTART_TARGETS}) AS targets WHERE targets.card_id = tasks.card_id)
  ORDER BY task_key
`

const MERGES_OF_AN_OLD_BODY = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'merge' AND tasks.state IN ('${QUEUED}', '${LEASED}') AND tasks.head = prs.head
    AND prs.body_sha IS NOT NULL AND tasks.task_key NOT LIKE '%:pr-body-' || prs.body_sha
  ORDER BY tasks.task_key
`

const A_MERGED_CARD_STILL_NEEDS_IT = `(tasks.queue IN ('merge', 'close', 'witness') AND tasks.state = '${LEASED}' AND tasks.lease_until >= ?) OR (NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${CARD_CLOSED}' AND closed.card_id = tasks.card_id) AND (tasks.queue = 'close' OR (tasks.queue = 'witness' AND ${A_CLOSE_DENIED_ON_THIS_WITNESS})))`

const TASKS_OF_A_CLOSED_PULL_REQUEST = `SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.state IN (${UNFINISHED_STATES}) AND (prs.state = 'closed' OR (prs.state = 'merged' AND NOT (${A_MERGED_CARD_STILL_NEEDS_IT})))
  ORDER BY tasks.task_key`

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

function withdrawnMergesALaterShardOf(shards: string): string {
  return `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'merge' AND tasks.state = '${WITHDRAWN}' AND prs.state = 'open' AND prs.head = tasks.head
    AND NOT EXISTS (SELECT 1 FROM events AS requeued WHERE requeued.type = '${TASK_REQUEUED}' AND json_extract(requeued.payload, '$.task_key') = tasks.task_key)
    AND EXISTS (SELECT 1 FROM (${shards}) AS shard WHERE shard.event_id > tasks.event_id)
  ORDER BY tasks.task_key
`
}

const WITHDRAWN_MERGES_A_LATER_SHARD_NAMES = withdrawnMergesALaterShardOf(unspentShardsOf('tasks.card_id', 'tasks.pr'))

const WITHDRAWN_MERGES_A_LATER_WINDOW_SHARD_COVERS = withdrawnMergesALaterShardOf(WINDOW_SHARDS_LIVE_AT)

const ANSWERS_WHOSE_STOP_NO_LONGER_HOLDS = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.failures, stop.id AS failure,
    json_extract(stop.payload, '$.reason') = '${FAULT}' AS fault FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  JOIN events AS stop ON stop.dedupe_key = '${CARD_STOPPED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.queue = 'answer' AND tasks.state = '${COMPLETED}' AND tasks.task_key NOT LIKE '%:stop-%'
    AND prs.state = 'open' AND prs.head = tasks.head
    AND stop.id = ${latestTurnOf('tasks.card_id')}
    AND json_extract(stop.payload, '$.reason') IN ('${FAULT}', '${QUESTION_OWNER}') AND NOT ${AN_OPEN_QUESTION}
  ORDER BY tasks.task_key
`

interface TaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
}

interface StoppedRow extends TaskRow {
  failure: number
}

interface ReviewRow extends TaskRow {
  body_sha: string
  card_body: unknown
}

type SupersededReviewRow = ReviewRow & StoppedRow

interface AlarmRow extends StoppedRow {
  cause: string
}

interface StoppedAnswerRow extends StoppedRow {
  failures: number
  fault: number
}

export interface QueuedTask extends TaskIdentity {
  stop?: number
  cardBody?: string
  base?: string
  prBody?: string
  decision?: number
}

const CARD_BODY_QUEUES: readonly Queue[] = ['answer', 'witness', 'close']
const STOP_SUFFIX = /:stop-([1-9]\d*)$/
const BODY_SHA = /^[0-9a-f]{8,64}$/
const ANSWER_CARD_BODY = /:card-body-([0-9a-f]{8,64})(?::base-[0-9a-f]{40})?(?::decision-[1-9]\d*)?(?::stop-[1-9]\d*)?$/
const MERGE_PR_BODY = /:pr-body-([0-9a-f]{8,64})$/
const WITNESS_BASE = /:base-([0-9a-f]{40})(?::stop-[1-9]\d*)?$/

function cardBodySegment(task: QueuedTask): string {
  if (task.cardBody === undefined)
    return ''
  if (!CARD_BODY_QUEUES.includes(task.queue) || !BODY_SHA.test(task.cardBody))
    throw new Error(`only an answer task carries a card body sha, or a witness or a close task:${task.queue}, ${task.cardBody}`)
  return `:card-body-${task.cardBody}`
}

function baseSegment(task: QueuedTask): string {
  if (task.base === undefined)
    return ''
  if (task.queue !== 'witness' || task.cardBody === undefined || !isFullSha(task.base))
    throw new Error(`only a witness task with a card body carries a base sha: ${task.queue}, ${task.base}`)
  return `:base-${task.base}`
}

function prBodySegment(task: QueuedTask): string {
  if (task.prBody === undefined)
    return ''
  if (task.queue !== 'merge' || task.pr === undefined || !BODY_SHA.test(task.prBody))
    throw new Error(`only a merge task of a pull request carries a pull request body sha: ${task.queue}, ${task.prBody}`)
  return `:pr-body-${task.prBody}`
}

function mergeBodyOfKey(key: string): string | undefined {
  return MERGE_PR_BODY.exec(key)?.[1]
}

export function baseOfKey(key: string): string | undefined {
  return WITNESS_BASE.exec(key)?.[1]
}

export function keyOf(task: QueuedTask): string {
  const key = `${taskKey(task)}${cardBodySegment(task)}${baseSegment(task)}${prBodySegment(task)}${decisionSegment(task)}`
  return task.stop === undefined ? key : `${key}:stop-${task.stop}`
}

export function answerCardBodyOf(row: Pick<Candidate, 'card_body'>): string | undefined {
  return typeof row.card_body === 'string' && BODY_SHA.test(row.card_body) ? row.card_body : undefined
}

function stopIn(key: unknown): number | undefined {
  const match = typeof key === 'string' ? STOP_SUFFIX.exec(key) : null
  return match === null ? undefined : Number(match[1])
}

function cardBodyIn(key: unknown): string | undefined {
  const match = typeof key === 'string' ? ANSWER_CARD_BODY.exec(key) : null
  return match === null ? undefined : match[1]
}

function openCandidates(db: DatabaseSync, ts: string, queue: Queue, rows: Candidate[]): QueuedTask[] {
  return rows.filter(row => !closedByRounds(db, ts, queue, row.pr, row.head)).map((row) => {
    const input = queue !== 'review' || row.body_sha === undefined ? undefined : reviewInputOf(row.body_sha, row.card_body)
    const cardBody = CARD_BODY_QUEUES.includes(queue) ? answerCardBodyOf(row) : undefined
    const base = queue === 'witness' && cardBody !== undefined ? row.witness_base ?? undefined : undefined
    const prBody = queue === 'merge' && typeof row.body_sha === 'string' && BODY_SHA.test(row.body_sha) ? row.body_sha : undefined
    return { queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, stop: row.stop ?? undefined, input, cardBody, base, prBody }
  })
}

export function reviewCandidates(db: DatabaseSync, ts: string): QueuedTask[] {
  return openCandidates(db, ts, 'review', candidateRows(db, REVIEW_CANDIDATES, everyRow))
}

function holdsOfTheUpdateTurn(db: DatabaseSync, ts: string): (Candidate & { updated_at: string })[] {
  const since = new Date(Date.parse(ts) - AN_UPDATED_PR_HOLDS_MS).toISOString()
  const rows = db.prepare(UPDATED_AND_ON_ITS_WAY_TO_MERGE).all(since) as unknown as (Candidate & { updated_at: string })[]
  return rows.filter(aMergeCandidate(db, ts))
}

export function updateTurnHeldUntil(db: DatabaseSync, ts: string, pr: number): string | null {
  const holds = holdsOfTheUpdateTurn(db, ts)
  if (holds.length === 0 || holds.some(row => row.pr === pr))
    return null
  return new Date(Math.max(...holds.map(row => Date.parse(row.updated_at))) + AN_UPDATED_PR_HOLDS_MS).toISOString()
}

export function updateTurnHeldFrom(db: DatabaseSync, ts: string, pr: number): boolean {
  return updateTurnHeldUntil(db, ts, pr) !== null
}

export function updateCandidates(db: DatabaseSync, ts: string, rerun: RerunMode = 'as-now'): QueuedTask[] {
  const sent = rerun === 'by-layers' ? candidateRows(db, GREEN_CLEAN_A_MERGE_SENT_TO_UPDATE, aMergeCandidate(db, ts)) : []
  const conflicting = candidateRows(db, CONFLICTING_BY_CARD_PRIORITY, everyRow)
  const green = [...candidateRows(db, GREEN_BEHIND_BY_CARD_PRIORITY, aMergeCandidate(db, ts)), ...sent]
  const holders = new Set(holdsOfTheUpdateTurn(db, ts).map(row => row.pr))
  const inTurn = holders.size === 0 ? green : green.filter(row => holders.has(row.pr))
  return openCandidates(db, ts, 'update', withTheHeadsARerunIsDueOn(db, [...inTurn, ...conflicting].slice(0, 1)))
}

export function closeCandidates(db: DatabaseSync, ts: string): QueuedTask[] {
  return openCandidates(db, ts, 'close', candidateRows(db, CLOSE_CANDIDATES, everyRow))
}

const ANSWER_CANDIDATES = [QUESTION_CANDIDATES, CHANGES_CANDIDATES, RED_CI_CANDIDATES, DIRTY_THE_UPDATE_COULD_NOT_MERGE, RED_WITNESS_CANDIDATES] as const

const ANSWERS_LEASED_NOW = `SELECT card_id, task_key FROM tasks WHERE queue = 'answer' AND state = '${LEASED}'`

export function witnessCandidates(db: DatabaseSync, ts: string): QueuedTask[] {
  const rows = [...candidateRows(db, WITNESS_CANDIDATES_ON_NO_RECORD, everyRow), ...candidateRows(db, WITNESS_CANDIDATES_ON_A_DENIED_BASE, everyRow), ...candidateRows(db, WITNESS_CANDIDATES_ON_MAIN, namesWitnesses)]
  return openCandidates(db, ts, 'witness', rows)
}

export function answerCandidates(db: DatabaseSync, ts: string): QueuedTask[] {
  const leased = db.prepare(ANSWERS_LEASED_NOW).all() as { card_id: number, task_key: string }[]
  const answering = new Set(leased.map(row => Number(row.card_id)))
  const leasedKeys = new Set(leased.map(row => row.task_key))
  return withDecidedContinuations(db, ANSWER_CANDIDATES.flatMap(query => openCandidates(db, ts, 'answer', candidateRows(db, query, everyRow))).filter(task => !answering.has(task.cardId) || leasedKeys.has(keyOf(task))), { decisions: decisionsInForceAt(db, new Date(ts)), sql: { cardBody: cardBodyShaOf, latestTurn: latestTurnOf, notAWindowCard, downgradeWaitOpenOn: aDowngradeWaitOpenOn }, pastTheLimit: (pr, head) => outOfRounds(db, 'answer', pr) && mergeDecidedPastRoundLimit(db, ts, pr, head) === null, cardBodyOf: answerCardBodyOf })
}

export function mergeCandidates(db: DatabaseSync, ts: string, rerun: RerunMode = 'as-now'): QueuedTask[] {
  return openCandidates(db, ts, 'merge', mergeRows(db, ts, rerun))
}

export function launchTasks(db: DatabaseSync, onOverlap?: OverlapCatch): QueuedTask[] {
  return launchCandidates(db, undefined, undefined, onOverlap).map(({ cardId, generation }) => ({ queue: 'launch', cardId, generation }))
}

export interface Derived {
  queued: string[]
  superseded: string[]
}

export function identityOf(event: StoredEvent): { key: string, queue: Queue } {
  const payload = payloadOf(event)
  const queue = QUEUES.find(each => each === payload.queue) ?? reject(`queue is not one of ${QUEUES.join(' | ')}`)
  const cardId = event.card_id ?? reject(`${event.type} needs a card_id`)
  const generation = typeof payload.generation === 'string' ? payload.generation : undefined
  const stop = queue === 'answer' ? stopIn(payload.task_key) : undefined
  const cardBody = CARD_BODY_QUEUES.includes(queue) ? cardBodyIn(payload.task_key) : undefined
  const input = queue === 'review' ? reviewInputOfKey(payload.task_key) : undefined
  if (input !== undefined && (event.pr === null || event.head === null))
    reject(`${event.type} of a review input needs a pr and a head`)
  const base = queue === 'witness' ? baseOfKey(String(payload.task_key)) : undefined
  const prBody = queue === 'merge' ? mergeBodyOfKey(String(payload.task_key)) : undefined
  const key = keyOf({ queue, cardId, pr: event.pr ?? undefined, head: event.head ?? undefined, generation, stop, input, cardBody, base, prBody, decision: answerDecisionOfKey(queue, payload.task_key) })
  if (payload.task_key !== key)
    reject(`task_key ${String(payload.task_key)} is not ${key}`)
  return { key, queue }
}

function taskRow(db: DatabaseSync, key: string): { state: string, event_id: number } | undefined {
  return db.prepare('SELECT state, event_id FROM tasks WHERE task_key = ?').get(key) as { state: string, event_id: number } | undefined
}

function foldEnqueued(db: DatabaseSync, event: StoredEvent): void {
  const { key, queue } = identityOf(event)
  if (taskRow(db, key) !== undefined)
    reject(`task ${key} is already queued`)
  db.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(key, queue, event.card_id, event.pr, event.head, QUEUED, event.id)
}

function foldSuperseded(db: DatabaseSync, event: StoredEvent): void {
  const { key } = identityOf(event)
  const task = taskRow(db, key) ?? reject(`task ${key} was never queued`)
  if (task.state === SUPERSEDED)
    reject(`task ${key} is already superseded`)
  db.prepare('UPDATE tasks SET state = ?, event_id = ? WHERE task_key = ?').run(SUPERSEDED, event.id, key)
}

function foldRequeued(db: DatabaseSync, event: StoredEvent): void {
  const { key, queue } = identityOf(event)
  const task = taskRow(db, key) ?? reject(`task ${key} was never queued`)
  const requeuable = queue === 'answer' || queue === 'update' ? REQUEUABLE_AFTER_COMPLETION : REQUEUABLE
  if (!requeuable.has(task.state))
    reject(`task ${key} is ${task.state}, not ${[...requeuable].join(' or ')}`)
  const failures = payloadOf(event).fault === true ? 'failures + 1' : '0'
  db.prepare(`UPDATE tasks SET state = ?, failures = ${failures}, event_id = ? WHERE task_key = ?`).run(QUEUED, event.id, key)
}

function foldWithdrawn(db: DatabaseSync, event: StoredEvent): void {
  const { key } = identityOf(event)
  const task = taskRow(db, key) ?? reject(`task ${key} was never queued`)
  if (!UNFINISHED.has(task.state))
    reject(`task ${key} is ${task.state}, not ${[...UNFINISHED].join(' or ')}`)
  db.prepare('UPDATE tasks SET state = ?, event_id = ? WHERE task_key = ?').run(WITHDRAWN, event.id, key)
}

interface LeasedRow {
  task_key: string
  state: string
  lease_gen: number
}

function leasedRowOf(db: DatabaseSync, key: string): LeasedRow | undefined {
  return db.prepare('SELECT task_key, state, lease_gen FROM tasks WHERE task_key = ?').get(key) as LeasedRow | undefined
}

function leaseUntil(ts: string): string {
  return new Date(Date.parse(ts) + LEASE_MS).toISOString()
}

function leaseGenOf(payload: Record<string, unknown>): number {
  const value = payload.lease_gen
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : reject('lease_gen is not a positive integer')
}

function heldRow(db: DatabaseSync, event: StoredEvent): { row: LeasedRow, payload: Record<string, unknown> } {
  const { key } = identityOf(event)
  const payload = payloadOf(event)
  const row = leasedRowOf(db, key) ?? reject(`task ${key} was never queued`)
  if (row.state !== LEASED || row.lease_gen !== leaseGenOf(payload))
    reject(`task ${key} is not leased under lease_gen ${String(payload.lease_gen)}`)
  return { row, payload }
}

function foldLeased(db: DatabaseSync, event: StoredEvent): void {
  const { key } = identityOf(event)
  const payload = payloadOf(event)
  const row = leasedRowOf(db, key) ?? reject(`task ${key} was never queued`)
  if (row.state !== QUEUED)
    reject(`task ${key} is ${row.state}, not queued`)
  if (leaseGenOf(payload) !== row.lease_gen + 1)
    reject(`lease_gen ${String(payload.lease_gen)} does not follow ${row.lease_gen}`)
  db.prepare('UPDATE tasks SET state = ?, lease_gen = ?, lease_until = ?, event_id = ? WHERE task_key = ?')
    .run(LEASED, row.lease_gen + 1, leaseUntil(event.ts), event.id, key)
}

function foldRenewed(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET lease_until = ?, event_id = ? WHERE task_key = ?').run(leaseUntil(event.ts), event.id, row.task_key)
}

function foldCompleted(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, event_id = ? WHERE task_key = ?').run(COMPLETED, event.id, row.task_key)
}

function foldFailed(db: DatabaseSync, event: StoredEvent): void {
  const { row, payload } = heldRow(db, event)
  const next = typeof payload.next === 'string' && AFTER_A_LEASE.has(payload.next) ? payload.next : reject(`next is not one of ${[...AFTER_A_LEASE].join(' | ')}`)
  const counted = payload.uncounted === true ? 0 : 1
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, failures = failures + ?, event_id = ? WHERE task_key = ?').run(next, counted, event.id, row.task_key)
}

function foldReleased(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, event_id = ? WHERE task_key = ?').run(QUEUED, event.id, row.task_key)
}

function foldHeartbeat(db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id === null)
    reject('a heartbeat names no card')
  const payload = payloadOf(event)
  if (typeof payload.task_key !== 'string')
    return
  db.prepare(`UPDATE tasks SET lease_until = ? WHERE state = '${LEASED}' AND task_key = ? AND lease_gen = ? AND card_id = ?`)
    .run(leaseUntil(event.ts), payload.task_key, leaseGenOf(payload), event.card_id)
}

const QUEUE_FOLDS: Record<string, Fold> = {
  [TASK_ENQUEUED]: foldEnqueued,
  [TASK_SUPERSEDED]: foldSuperseded,
  [TASK_REQUEUED]: foldRequeued,
  [TASK_WITHDRAWN]: foldWithdrawn,
}

const LEASE_TASK_FOLDS: Record<string, Fold> = {
  [SESSION_HEARTBEAT]: foldHeartbeat,
  [TASK_RELEASED]: foldReleased,
  [TASK_LEASED]: foldLeased,
  [TASK_RENEWED]: foldRenewed,
  [TASK_COMPLETED]: foldCompleted,
  [TASK_FAILED]: foldFailed,
  [TASK_EXPIRED]: foldFailed,
}

const TASKS_FOLDS: Record<string, Fold> = { ...QUEUE_FOLDS, ...LEASE_TASK_FOLDS }

export const TASKS_PROJECTION: IncrementalProjection = { table: 'tasks', folds: TASKS_FOLDS }

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

function reduceTasksAfter(db: DatabaseSync, current: number): void {
  if (watermarkOf(db, TASKS_PROJECTION.table) === 0)
    markReduced(db, TASKS_PROJECTION.table, current)
  reduceProjection(db, TASKS_PROJECTION)
}

export function appendedAndReduced(db: DatabaseSync, event: BusEvent): boolean {
  const current = lastEventId(db)
  const appended = appendEvent(db, event)
  reduceTasksAfter(db, current)
  return appended
}

function reducedAfterItsAppend(db: DatabaseSync, event: StoredEvent): void {
  reduceTasksAfter(db, event.id - 1)
}

function reducedOnAppend(folds: Record<string, Fold>): Record<string, Fold> {
  return Object.fromEntries(Object.keys(folds).map(type => [type, reducedAfterItsAppend]))
}

export const TASK_FOLDS = reducedOnAppend(QUEUE_FOLDS)
export const LEASE_FOLDS = reducedOnAppend(LEASE_TASK_FOLDS)

export function generationField(generation: string | undefined): { generation?: string } {
  return generation === undefined ? {} : { generation }
}

function taskEvent(ts: string, type: string, task: QueuedTask, failure?: number, state?: number, fault = false): BusEvent {
  const key = keyOf(task)
  const after = failure === undefined ? {} : fault ? { failure, fault } : { failure }
  const plain = failure === undefined ? `${type}:${key}` : `${type}:${key}:${failure}`
  const dedupeKey = state === undefined ? plain : `${plain}:after-${state}`
  return { ts, type, actor: QUEUE_ACTOR, cardId: task.cardId, pr: task.pr ?? null, head: task.head ?? null, dedupeKey, payload: { task_key: key, queue: task.queue, ...generationField(task.generation), ...after }, legacy: false }
}

function written(db: DatabaseSync, event: BusEvent): boolean {
  return inTransaction(db, () => appendedAndReduced(db, event))
}

export function queueTaskWithin(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return appendedAndReduced(db, taskEvent(ts, TASK_ENQUEUED, task))
}

export function queueTask(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return written(db, taskEvent(ts, TASK_ENQUEUED, task))
}

function stateEventOf(db: DatabaseSync, task: QueuedTask): number | undefined {
  const row = db.prepare('SELECT event_id FROM tasks WHERE task_key = ?').get(keyOf(task)) as { event_id: number } | undefined
  return row === undefined ? undefined : Number(row.event_id)
}

export function supersedeTask(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return written(db, taskEvent(ts, TASK_SUPERSEDED, task, undefined, stateEventOf(db, task)))
}

function withdrawTask(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return written(db, taskEvent(ts, TASK_WITHDRAWN, task, undefined, stateEventOf(db, task)))
}

function parkUnderTheDowngradeWait(db: DatabaseSync, ts: string, task: QueuedTask): void {
  const event = taskEvent(ts, TASK_WITHDRAWN, task, undefined, stateEventOf(db, task))
  written(db, { ...event, payload: { ...event.payload as Record<string, unknown>, reason: DOWNGRADE_WAIT_OPEN } })
}

function identity(row: TaskRow): QueuedTask {
  const plain = { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined }
  const input = row.queue === 'review' ? reviewInputOfKey(row.task_key) : undefined
  const cardBody = CARD_BODY_QUEUES.includes(row.queue) ? cardBodyIn(row.task_key) : undefined
  const base = row.queue === 'witness' ? baseOfKey(row.task_key) : undefined
  const prBody = row.queue === 'merge' ? mergeBodyOfKey(row.task_key) : undefined
  return { ...plain, generation: generationOfKey(row.task_key, plain), stop: stopIn(row.task_key), input, cardBody, base, prBody, decision: answerDecisionOfKey(row.queue, row.task_key) }
}

export interface BodyAdmission { bodySha: string, event: string }

export function cardBodyAdmissionOf(db: DatabaseSync, cardId: number): BodyAdmission | null {
  const row = db.prepare(latestBodyAdmission('?', `json_extract(intake.payload, '$.bodySha') AS body_sha, intake.dedupe_key AS event`)).get(cardId) as { body_sha: unknown, event: unknown } | undefined
  return typeof row?.body_sha === 'string' && typeof row.event === 'string' ? { bodySha: row.body_sha, event: row.event } : null
}

export function cardBodyShaOfCard(db: DatabaseSync, cardId: number): string | null {
  return cardBodyAdmissionOf(db, cardId)?.bodySha ?? null
}

function reviewsOfAnOldInput(db: DatabaseSync): ReviewRow[] {
  return (db.prepare(REVIEWS_OF_AN_OLD_INPUT).all() as unknown as ReviewRow[]).filter(row => !underCurrentInput(row))
}

function keyedOnAnOldCardBody(key: string, row: Pick<Candidate, 'card_body'>): boolean {
  const current = answerCardBodyOf(row)
  return current !== undefined && cardBodyIn(key) !== current
}

function leaseOnAnOldCardBody(key: string, row: Pick<Candidate, 'card_body'>): boolean {
  return cardBodyIn(key) !== undefined && keyedOnAnOldCardBody(key, row)
}

function answersOfAnOldCardBody(db: DatabaseSync): TaskRow[] {
  return (db.prepare(LIVE_ANSWERS_WITH_THE_CARD_BODY).all() as unknown as (TaskRow & Pick<Candidate, 'card_body'> & { state: string })[])
    .filter(row => row.state === QUEUED ? keyedOnAnOldCardBody(row.task_key, row) : leaseOnAnOldCardBody(row.task_key, row))
}

export function answerOnAnOldCardBody(db: DatabaseSync, task: { taskKey: string, cardId: number }): boolean {
  return leaseOnAnOldCardBody(task.taskKey, { card_body: cardBodyShaOfCard(db, task.cardId) })
}

export function supersededAnswerWithinItsLease(db: DatabaseSync, cardId: number, ts: string): boolean {
  return db.prepare(A_SUPERSEDED_ANSWER_WITHIN_ITS_LEASE).get(cardId, ts) !== undefined
}

export function reviewKeysOfAnOldInput(db: DatabaseSync): string[] {
  return reviewsOfAnOldInput(db).map(row => row.task_key)
}

function reviewsOfTheCurrentInputAgain(db: DatabaseSync): SupersededReviewRow[] {
  return (db.prepare(SUPERSEDED_REVIEWS_ON_THE_CURRENT_HEAD).all() as unknown as SupersededReviewRow[]).filter(underCurrentInput)
}

export function reviewKeysOfTheCurrentInputAgain(db: DatabaseSync): string[] {
  return reviewsOfTheCurrentInputAgain(db).map(row => row.task_key)
}

function mergesAndUpdatesDueAgain(db: DatabaseSync, ts: string): StoppedRow[] {
  const due = new Set([...mergeCandidates(db, ts), ...updateCandidates(db, ts)].map(keyOf))
  return (db.prepare(SUPERSEDED_MERGES_AND_UPDATES_ON_THE_CURRENT_HEAD).all() as unknown as StoppedRow[]).filter(row => due.has(row.task_key))
}

function updatesSpentBeforeAMergeSentThem(db: DatabaseSync, ts: string): StoppedRow[] {
  return (candidateRows(db, GREEN_CLEAN_A_MERGE_SENT_TO_UPDATE, aMergeCandidate(db, ts)) as (Candidate & { sent_at: number })[]).flatMap((row) => {
    const spent: StoppedRow = { task_key: keyOf({ queue: 'update', cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined }), queue: 'update', card_id: row.card_id, pr: row.pr, head: row.head, failure: Number(row.sent_at) }
    const task = taskRow(db, spent.task_key)
    return task?.state === COMPLETED && Number(task.event_id) < spent.failure ? [spent] : []
  })
}

function underCurrentInput(row: ReviewRow): boolean {
  const current: QueuedTask = { queue: 'review', cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, input: reviewInputOf(row.body_sha, row.card_body) }
  return current.input === undefined || keyOf(current) === row.task_key
}

function requeueTask(db: DatabaseSync, ts: string, row: StoppedRow, fault = false): boolean {
  return (answerDecisionOfKey(row.queue, row.task_key) !== undefined || !closedByRounds(db, ts, row.queue, row.pr, row.head)) && written(db, taskEvent(ts, TASK_REQUEUED, identity(row), row.failure, undefined, fault))
}

function requeueOnceItsCauseIsGone(db: DatabaseSync, ts: string, row: AlarmRow): boolean {
  if (closedByRounds(db, ts, row.queue, row.pr, row.head))
    return false
  const event = taskEvent(ts, TASK_REQUEUED, identity(row), row.failure)
  return written(db, { ...event, payload: { ...event.payload as Record<string, unknown>, cause: row.cause } })
}

function alarmed(db: DatabaseSync, ts: string, row: StoppedAnswerRow): void {
  const failures = row.failures + 1
  const detail = `${failures} failures in a row on ${row.task_key}, the last a ${FAULT} stop`
  appendEvent(db, { ts, type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${BOARD_ALARM}:${row.task_key}`, payload: { task_key: row.task_key, reason: FAULT, failures, detail }, legacy: false })
}

function setAgainAfterItsStop(db: DatabaseSync, ts: string, row: StoppedAnswerRow): boolean {
  const fault = row.fault === 1
  if (fault && row.failures + 1 >= FAILURES_TO_STOP) {
    alarmed(db, ts, row)
    return false
  }
  return requeueTask(db, ts, row, fault)
}

export function deriveQueues(db: DatabaseSync, ts: string): Derived {
  const derived: Derived = { queued: [], superseded: [] }
  for (const row of db.prepare(TASKS_OF_AN_OLD_HEAD).all() as unknown as TaskRow[]) {
    if (supersedeTask(db, ts, identity(row)))
      derived.superseded.push(row.task_key)
  }
  for (const row of db.prepare(TASKS_OF_A_CLOSED_PULL_REQUEST).all(ts) as unknown as TaskRow[])
    withdrawTask(db, ts, identity(row))
  for (const row of [...reviewsOfAnOldInput(db), ...answersOfAnOldCardBody(db), ...db.prepare(MERGES_OF_AN_OLD_BODY).all() as unknown as TaskRow[]]) {
    if (supersedeTask(db, ts, identity(row)))
      derived.superseded.push(row.task_key)
  }
  for (const [query, ...params] of [[STOPPED_ON_NO_CARD_TREE], [WITHDRAWN_ON_A_WITNESS_NOW_GREEN], [WITHDRAWN_MERGES_A_LATER_SHARD_NAMES], [WITHDRAWN_MERGES_A_LATER_WINDOW_SHARD_COVERS, ts], [MERGES_PARKED_ON_A_QUESTION_NOW_CLOSED], [ANSWERS_PARKED_ON_A_DOWNGRADE_WAIT_NOW_CLOSED]]) {
    for (const row of db.prepare(query!).all(...params) as unknown as StoppedRow[]) {
      if (requeueTask(db, ts, row))
        derived.queued.push(row.task_key)
    }
  }
  for (const row of [...reviewsOfTheCurrentInputAgain(db), ...mergesAndUpdatesDueAgain(db, ts), ...updatesSpentBeforeAMergeSentThem(db, ts)]) {
    if (requeueTask(db, ts, row))
      derived.queued.push(row.task_key)
  }
  for (const row of db.prepare(ALARMS_WHOSE_CAUSE_IS_GONE).all() as unknown as AlarmRow[]) {
    if (requeueOnceItsCauseIsGone(db, ts, row))
      derived.queued.push(row.task_key)
  }
  for (const row of db.prepare(ANSWERS_WHOSE_STOP_NO_LONGER_HOLDS).all() as unknown as StoppedAnswerRow[]) {
    if (setAgainAfterItsStop(db, ts, row))
      derived.queued.push(row.task_key)
  }
  for (const row of db.prepare(QUEUED_ANSWERS_UNDER_A_DOWNGRADE_WAIT).all() as unknown as TaskRow[])
    parkUnderTheDowngradeWait(db, ts, identity(row))
  openWindowWaits(db, ts)
  readmitLiftedLaunchStops(db, ts)
  openLostRecutWaits(db, ts)
  for (const tasksOf of [...candidates(db, ts), () => launchTasks(db)]) {
    for (const task of tasksOf()) {
      if (queueTask(db, ts, task))
        derived.queued.push(keyOf(task))
    }
  }
  return derived
}
