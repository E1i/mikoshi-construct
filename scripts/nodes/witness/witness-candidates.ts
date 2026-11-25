import type { DatabaseSync } from 'node:sqlite'
import type { EventRow } from '../../core/events-query.js'
import type { Admits, CandidateRules, QueuedTask, QueueSource, RequeueRow } from '../../core/queue.js'
import type { TaskRow } from '../../core/tasks-query.js'
import { aCardInStates, cardBodiesWhere } from '../../core/card-readings.js'
import { anEventWhere, events, eventsWhere, latestEventIdWhere } from '../../core/events-query.js'
import { CARD_CLOSED, CARD_STARTED, POLICY_DENIED, WITNESS_RECORDED } from '../../core/events.js'
import { MAIN_BRANCH } from '../../core/identifiers.js'
import { A_MAIN_RECORDED, anOpenPrOnTheHead, aPrOfCard, LATEST_MAIN_SHA, openPrsWhere } from '../../core/pr-readings.js'
import { candidateRows, cardBodyShaOf, everyRow, openCandidates, WITHDRAWN } from '../../core/queue.js'
import { all as allTasks } from '../../core/tasks-query.js'

export interface WitnessParts {
  rules: CandidateRules
  namesWitnesses: Admits
}

const WITNESS = 'witness'
const QUEUES_HELD_BY_A_WITNESS: readonly string[] = ['merge', 'close']

function aWitnessRecordedOnTheCardBody(card: string, head: string): string {
  return anEventWhere('recorded', `recorded.type = '${WITNESS_RECORDED}' AND recorded.legacy = 0
        AND recorded.card_id = ${card} AND ${head}
        AND json_extract(recorded.payload, '$.cardBody') = ${cardBodyShaOf(card)}`)
}

const WITNESS_CANDIDATES_ON_NO_RECORD = openPrsWhere(`pr, card_id, head, ${cardBodyShaOf('prs.card_id')} AS card_body, NULL AS witness_base`, `base = '${MAIN_BRANCH}' AND draft = 0 AND card_id IS NOT NULL AND head IS NOT NULL
    AND ${cardBodyShaOf('prs.card_id')} IS NOT NULL
    AND NOT ${aWitnessRecordedOnTheCardBody('prs.card_id', 'recorded.head = prs.head')}`)

const WITNESS_CANDIDATES_ON_MAIN = cardBodiesWhere(`NULL AS pr, body.card_id, ${LATEST_MAIN_SHA} AS head, ${cardBodyShaOf('body.card_id')} AS card_body, NULL AS witness_base, body.text`, `${A_MAIN_RECORDED}
    AND ${cardBodyShaOf('body.card_id')} IS NOT NULL
    AND ${anEventWhere('started', `started.type = '${CARD_STARTED}' AND started.legacy = 0 AND started.card_id = body.card_id`)}
    AND NOT ${aPrOfCard('body.card_id')}
    AND NOT ${aCardInStates('body.card_id', ['closed', 'dropped', 'merged'])}
    AND NOT ${anEventWhere('closed', `closed.type = '${CARD_CLOSED}' AND closed.card_id = body.card_id`)}
    AND NOT ${aWitnessRecordedOnTheCardBody('body.card_id', 'recorded.pr IS NULL')}`)

const LATEST_WITNESS_DENIAL = latestEventIdWhere('latest', `latest.type = '${POLICY_DENIED}' AND latest.legacy = 0 AND latest.card_id = denied.card_id AND latest.head = denied.head
    AND json_extract(latest.payload, '$.reason') = '${WITNESS}'`)

const WITNESS_CANDIDATES_ON_A_DENIED_BASE = eventsWhere('denied', `denied.pr, denied.card_id, denied.head, ${cardBodyShaOf('denied.card_id')} AS card_body, json_extract(denied.payload, '$.base') AS witness_base`, `denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.pr IS NOT NULL AND denied.card_id IS NOT NULL AND denied.head IS NOT NULL
    AND json_extract(denied.payload, '$.reason') = '${WITNESS}' AND json_type(denied.payload, '$.base') = 'text'
    AND denied.id = ${LATEST_WITNESS_DENIAL}
    AND ${cardBodyShaOf('denied.card_id')} IS NOT NULL
    AND NOT ${aWitnessRecordedOnTheCardBody('denied.card_id', `recorded.head = denied.head AND json_extract(recorded.payload, '$.base') = json_extract(denied.payload, '$.base')`)}`)

function latestWitnessDenialOf(db: DatabaseSync, task: TaskRow): EventRow | undefined {
  return events(db, { types: [POLICY_DENIED], card: task.card_id, head: task.head!, newestFirst: true })
    .find(denied => denied.data?.reason === WITNESS && denied.data.command === task.queue)
}

function greenOnTheDeniedBase(db: DatabaseSync, task: TaskRow, denied: EventRow): boolean {
  const base = denied.data?.base
  return base !== undefined && base !== null && events(db, { types: [WITNESS_RECORDED], card: task.card_id, head: task.head!, since: task.event_id })
    .some(green => green.data?.verdict === 'green' && green.data.base === base)
}

function aWitnessNowGreen(db: DatabaseSync, task: TaskRow): boolean {
  const denied = latestWitnessDenialOf(db, task)
  return denied !== undefined && greenOnTheDeniedBase(db, task, denied)
}

function byTaskKey(a: TaskRow, b: TaskRow): number {
  return a.task_key < b.task_key ? -1 : a.task_key > b.task_key ? 1 : 0
}

function withdrawnOnAWitnessNowGreen(db: DatabaseSync): RequeueRow[] {
  return allTasks(db)
    .filter(task => QUEUES_HELD_BY_A_WITNESS.includes(task.queue) && task.state === WITHDRAWN && task.head !== null
      && aWitnessNowGreen(db, task) && (task.queue === 'close' || anOpenPrOnTheHead(db, task.pr, task.head)))
    .sort(byTaskKey)
    .map(task => ({ task_key: task.task_key, queue: task.queue as RequeueRow['queue'], card_id: task.card_id, pr: task.pr, head: task.head, failure: task.event_id }))
}

export function witnessCandidates(db: DatabaseSync, ts: string, parts: WitnessParts): QueuedTask[] {
  const merged = parts.rules.mergedCards(db)
  const rows = [...candidateRows(db, WITNESS_CANDIDATES_ON_NO_RECORD, everyRow, merged), ...candidateRows(db, WITNESS_CANDIDATES_ON_A_DENIED_BASE, everyRow, merged), ...candidateRows(db, WITNESS_CANDIDATES_ON_MAIN, parts.namesWitnesses, merged)]
  return openCandidates(db, ts, 'witness', rows, parts.rules)
}

export function witnessSource(): QueueSource {
  return { queue: 'witness', requeue: db => withdrawnOnAWitnessNowGreen(db) }
}
