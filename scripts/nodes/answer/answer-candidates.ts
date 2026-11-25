import type { DatabaseSync } from 'node:sqlite'
import type { BoundDecision } from '../../core/identifiers.js'
import type { Candidate, CandidateRules, QuestionAnswered, QueuedTask, QueueSource } from '../../core/queue.js'
import { aDowngradeWaitOpenOn, latestQuestionStopsWithTheirCard, notACardOf } from '../../core/card-readings.js'
import { eventsWhere, latestEventIdWhere } from '../../core/events-query.js'
import { CARD_HELD, CARD_RELEASED, CARD_STOPPED, POLICY_DENIED, WITNESS_RECORDED } from '../../core/events.js'
import { MAIN_BRANCH } from '../../core/identifiers.js'
import { A_RERUN_DUE } from '../../core/observations.js'
import { latestQuestionStops, openPrsWhere } from '../../core/pr-readings.js'
import { A_LAUNCH_STOP_WITH_NO_PULL_REQUEST, anOpenQuestion, answerCardBodyOf, candidateRows, cardBodyShaOf, everyRow, HELD_BY_A_DEPENDENCY, keyOf, latestTurnOf, LEASED, MERGE_REFUSED, openCandidates, THE_WINDOW_AMENDS_THE_CARD_FIRST } from '../../core/queue.js'
import { ofQueue } from '../../core/tasks-query.js'
import { strandedAnswers } from './duties/index.js'

export interface CardSqlParts {
  cardBody: (card: string) => string
  latestTurn: (card: string) => string
  notAWindowCard: (card: string) => string
  downgradeWaitOpenOn: (card: string) => string
}

export interface Continuing {
  decisions: readonly BoundDecision[]
  sql: CardSqlParts
  pastTheLimit: (pr: number, head: string | null) => boolean
  cardBodyOf: (turn: { card_body: unknown }) => string | undefined
}

export type DecidedContinuer = (db: DatabaseSync, planned: readonly QueuedTask[], how: Continuing) => QueuedTask[]

export interface AnswerParts {
  rules: CandidateRules
  answered: QuestionAnswered
  continuations: DecidedContinuer
  windowWho: string
}

function anEvent(alias: string, condition: string): string {
  return `EXISTS (${eventsWhere(alias, '1', condition)})`
}

const RELEASED_AFTER_THE_TAKEOVER = anEvent('released', `released.type = '${CARD_RELEASED}' AND released.legacy = 0 AND released.card_id = stop.card_id AND released.id > taken.id`)

const TAKEN_OVER_AND_RELEASED_SINCE_THE_STOP = anEvent('taken', `taken.type = '${CARD_HELD}' AND taken.legacy = 0 AND taken.card_id = stop.card_id AND taken.id > stop.id AND json_extract(taken.payload, '$.takeover') = 1
  AND ${RELEASED_AFTER_THE_TAKEOVER}`)

function anOpenQuestionStandsLast(answered: QuestionAnswered): string {
  return anEvent('stop', `stop.id = ${latestTurnOf('prs.card_id')}
    AND stop.type = '${CARD_STOPPED}' AND ${anOpenQuestion(answered)} AND NOT ${TAKEN_OVER_AND_RELEASED_SINCE_THE_STOP}`)
}

function questionCandidates(notAWindowCard: (card: string) => string): string {
  return latestQuestionStops(
    latestQuestionStopsWithTheirCard(latestTurnOf),
    `stop.card_id, coalesce(stop.pr, cards.pr) AS pr, coalesce(prs.head, stop.head) AS head, stop.id AS stop, ${cardBodyShaOf('stop.card_id')} AS card_body`,
    `NOT ${THE_WINDOW_AMENDS_THE_CARD_FIRST} AND NOT ${A_LAUNCH_STOP_WITH_NO_PULL_REQUEST} AND ${notAWindowCard('stop.card_id')} AND NOT ${aDowngradeWaitOpenOn('stop.card_id')}
    AND (prs.pr IS NULL OR NOT ${HELD_BY_A_DEPENDENCY})`,
  )
}

function answerCandidatesWhere(condition: string, parts: AnswerParts, { answeredPastAnUnmergedDependency = false } = {}): string {
  return openPrsWhere(`pr, card_id, head, ${cardBodyShaOf('prs.card_id')} AS card_body`, `${condition} AND card_id IS NOT NULL AND head IS NOT NULL
    AND ${notACardOf(parts.windowWho)('prs.card_id')}
    AND NOT ${aDowngradeWaitOpenOn('prs.card_id')}
    ${answeredPastAnUnmergedDependency ? '' : `AND NOT ${HELD_BY_A_DEPENDENCY}`}
    AND NOT ${anOpenQuestionStandsLast(parts.answered)}`)
}

function answerQueries(parts: AnswerParts): readonly string[] {
  return [
    questionCandidates(notACardOf(parts.windowWho)),
    answerCandidatesWhere(`verdict_on_head = 'changes'`, parts),
    answerCandidatesWhere(`ci = 'red' AND NOT ${A_RERUN_DUE}`, parts, { answeredPastAnUnmergedDependency: true }),
    answerCandidatesWhere(`base = '${MAIN_BRANCH}' AND mergeable = 'dirty' AND draft = 0 AND ${anEvent('refused', `refused.type = '${POLICY_DENIED}' AND refused.legacy = 0 AND refused.pr = prs.pr AND refused.head = prs.head
      AND json_extract(refused.payload, '$.reason') = '${MERGE_REFUSED}'`)}`, parts),
    answerCandidatesWhere(anEvent('red', `red.id = ${latestEventIdWhere('latest', `latest.type = '${WITNESS_RECORDED}' AND latest.legacy = 0 AND latest.pr = prs.pr AND latest.head = prs.head`)}
      AND json_extract(red.payload, '$.verdict') = 'red'`), parts),
  ]
}

function shiftCardBodyOf(windowWho: string): string {
  return `SELECT ${notACardOf(windowWho)(':card')} AS shift, ${cardBodyShaOf(':card')} AS card_body`
}

function strandedAnswerCandidates(db: DatabaseSync, windowWho: string): Candidate[] {
  const shiftCardBody = db.prepare(shiftCardBodyOf(windowWho))
  return strandedAnswers(db).flatMap(({ card, answer }) => {
    const row = shiftCardBody.get({ card }) as { shift: number, card_body: unknown }
    return row.shift === 1 ? [{ pr: null, card_id: card, head: answer.to, card_body: row.card_body }] : []
  })
}

export function answerCandidates(db: DatabaseSync, ts: string, parts: AnswerParts): QueuedTask[] {
  const { rules } = parts
  const leased = ofQueue(db, 'answer').filter(task => task.state === LEASED)
  const answering = new Set(leased.map(row => row.card_id))
  const leasedKeys = new Set(leased.map(row => row.task_key))
  const merged = rules.mergedCards(db)
  const rows = [...answerQueries(parts).map(query => candidateRows(db, query, everyRow, merged)), strandedAnswerCandidates(db, parts.windowWho)]
  const planned = rows.flatMap(found => openCandidates(db, ts, 'answer', found, rules)).filter(task => !answering.has(task.cardId) || leasedKeys.has(keyOf(task)))
  return parts.continuations(db, planned, { decisions: rules.decisionsAt(db, ts), sql: { cardBody: cardBodyShaOf, latestTurn: latestTurnOf, notAWindowCard: notACardOf(parts.windowWho), downgradeWaitOpenOn: aDowngradeWaitOpenOn }, pastTheLimit: (pr, head) => rules.outOfRounds(db, 'answer', pr) && rules.mergeDecided(db, ts, pr, head) === null, cardBodyOf: answerCardBodyOf })
}

export function answerSource(parts: AnswerParts): QueueSource {
  return { queue: 'answer', enqueue: (db, ts) => answerCandidates(db, ts, parts) }
}
