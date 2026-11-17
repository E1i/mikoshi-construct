import type { DatabaseSync } from 'node:sqlite'
import type { BoundDecision } from '../../core/identifiers.js'
import type { CandidateRules, QuestionAnswered, QueuedTask, QueueSource } from '../../core/queue.js'
import { CARD_BODIES } from '../../core/card-bodies.js'
import { CARD_HELD, CARD_RELEASED, CARD_STOPPED, POLICY_DENIED, WITNESS_RECORDED } from '../../core/events.js'
import { MAIN_BRANCH } from '../../core/identifiers.js'
import { A_RERUN_DUE } from '../../core/observations.js'
import { A_LAUNCH_STOP_WITH_NO_PULL_REQUEST, aDowngradeWaitOpenOn, anOpenQuestion, answerCardBodyOf, candidateRows, cardBodyShaOf, everyRow, HELD_BY_A_DEPENDENCY, keyOf, latestQuestionStops, latestTurnOf, LEASED, MERGE_REFUSED, openCandidates, THE_WINDOW_AMENDS_THE_CARD_FIRST } from '../../core/queue.js'

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

function notAWindowCardOf(windowWho: string): (card: string) => string {
  return card => `NOT EXISTS (SELECT 1 FROM ${CARD_BODIES} AS body WHERE body.card_id = ${card} AND body.who = '${windowWho}')`
}

function questionCandidates(notAWindowCard: (card: string) => string): string {
  return latestQuestionStops(
    `stop.card_id, coalesce(stop.pr, cards.pr) AS pr, coalesce(prs.head, stop.head) AS head, stop.id AS stop, ${cardBodyShaOf('stop.card_id')} AS card_body`,
    `NOT ${THE_WINDOW_AMENDS_THE_CARD_FIRST} AND NOT ${A_LAUNCH_STOP_WITH_NO_PULL_REQUEST} AND ${notAWindowCard('stop.card_id')} AND NOT ${aDowngradeWaitOpenOn('stop.card_id')}
    AND (prs.pr IS NULL OR NOT ${HELD_BY_A_DEPENDENCY})`,
  )
}

function answerCandidatesWhere(condition: string, parts: AnswerParts, { answeredPastAnUnmergedDependency = false } = {}): string {
  return `
  SELECT pr, card_id, head, ${cardBodyShaOf('prs.card_id')} AS card_body FROM prs
  WHERE state = 'open' AND ${condition} AND card_id IS NOT NULL AND head IS NOT NULL
    AND ${notAWindowCardOf(parts.windowWho)('prs.card_id')}
    AND NOT ${aDowngradeWaitOpenOn('prs.card_id')}
    ${answeredPastAnUnmergedDependency ? '' : `AND NOT ${HELD_BY_A_DEPENDENCY}`}
    AND NOT EXISTS (
      SELECT 1 FROM events AS stop WHERE stop.id = ${latestTurnOf('prs.card_id')}
        AND stop.type = '${CARD_STOPPED}' AND ${anOpenQuestion(parts.answered)} AND NOT EXISTS (SELECT 1 FROM events AS taken JOIN events AS released ON released.type = '${CARD_RELEASED}' AND released.legacy = 0 AND released.card_id = stop.card_id AND released.id > taken.id WHERE taken.type = '${CARD_HELD}' AND taken.legacy = 0 AND taken.card_id = stop.card_id AND taken.id > stop.id AND json_extract(taken.payload, '$.takeover') = 1)
    )
  ORDER BY pr
`
}

function answerQueries(parts: AnswerParts): readonly string[] {
  return [
    questionCandidates(notAWindowCardOf(parts.windowWho)),
    answerCandidatesWhere(`verdict_on_head = 'changes'`, parts),
    answerCandidatesWhere(`ci = 'red' AND NOT ${A_RERUN_DUE}`, parts, { answeredPastAnUnmergedDependency: true }),
    answerCandidatesWhere(`base = '${MAIN_BRANCH}' AND mergeable = 'dirty' AND draft = 0 AND EXISTS (
    SELECT 1 FROM events AS refused WHERE refused.type = '${POLICY_DENIED}' AND refused.legacy = 0 AND refused.pr = prs.pr AND refused.head = prs.head
      AND json_extract(refused.payload, '$.reason') = '${MERGE_REFUSED}'
  )`, parts),
    answerCandidatesWhere(`EXISTS (
    SELECT 1 FROM events AS red WHERE red.id = (
      SELECT max(latest.id) FROM events AS latest WHERE latest.type = '${WITNESS_RECORDED}' AND latest.legacy = 0 AND latest.pr = prs.pr AND latest.head = prs.head
    ) AND json_extract(red.payload, '$.verdict') = 'red'
  )`, parts),
  ]
}

const ANSWERS_LEASED_NOW = `SELECT card_id, task_key FROM tasks WHERE queue = 'answer' AND state = '${LEASED}'`

export function answerCandidates(db: DatabaseSync, ts: string, parts: AnswerParts): QueuedTask[] {
  const { rules } = parts
  const leased = db.prepare(ANSWERS_LEASED_NOW).all() as { card_id: number, task_key: string }[]
  const answering = new Set(leased.map(row => Number(row.card_id)))
  const leasedKeys = new Set(leased.map(row => row.task_key))
  const planned = answerQueries(parts).flatMap(query => openCandidates(db, ts, 'answer', candidateRows(db, query, everyRow), rules)).filter(task => !answering.has(task.cardId) || leasedKeys.has(keyOf(task)))
  return parts.continuations(db, planned, { decisions: rules.decisionsAt(db, ts), sql: { cardBody: cardBodyShaOf, latestTurn: latestTurnOf, notAWindowCard: notAWindowCardOf(parts.windowWho), downgradeWaitOpenOn: aDowngradeWaitOpenOn }, pastTheLimit: (pr, head) => rules.outOfRounds(db, 'answer', pr) && rules.mergeDecided(db, ts, pr, head) === null, cardBodyOf: answerCardBodyOf })
}

export function answerSource(parts: AnswerParts): QueueSource {
  return { queue: 'answer', enqueue: (db, ts) => answerCandidates(db, ts, parts) }
}
