import type { DatabaseSync } from 'node:sqlite'
import type { Queue } from './identifiers.js'
import type { QueuedTask } from './queue.js'
import { existsSync } from 'node:fs'
import { BUSY_TIMEOUT_MS } from './db.js'
import { CARD_STOPPED, DECISION_RECORDED, QUESTION_OWNER, REVIEW_RECORDED } from './events.js'
import { openDatabase } from './sqlite.js'

export const CARD_DECISIONS_HEADING = 'Owner decisions in force for this card. They are the owner\'s answer: follow them, and do not ask the owner again what they settle.'

const DECISION_SUFFIX = /:decision-([1-9]\d*)$/
const ENDED_WITHOUT_RUNNING = `'superseded', 'withdrawn'`

export type CardDecisionLines = (db: DatabaseSync, cardId: number, now: Date) => string[]

export interface BoundDecision {
  decisionId: number
  cards: readonly number[]
}

export function cardDecisionBlock(decisions: readonly string[]): string[] {
  return decisions.length === 0 ? [] : [CARD_DECISIONS_HEADING, ...decisions]
}

export function withCardDecisions<Task extends { body: string }>(task: Task, decisions: readonly string[]): Task {
  const block = cardDecisionBlock(decisions)
  return block.length === 0 ? task : { ...task, body: `${task.body}\n\n${block.join('\n')}` }
}

export function busCardDecisions(busPath: string, linesOf: CardDecisionLines, now: () => Date = () => new Date()): (cardId: number) => string[] {
  return (cardId) => {
    if (!existsSync(busPath))
      return []
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return linesOf(db, cardId, now())
    }
    finally {
      db.close()
    }
  }
}

export function decisionSegment(task: { queue: Queue, decision?: number }): string {
  if (task.decision === undefined)
    return ''
  if (task.queue !== 'answer' || !Number.isSafeInteger(task.decision) || task.decision < 1)
    throw new Error(`only an answer task carries a decision id: ${task.queue}, ${task.decision}`)
  return `:decision-${task.decision}`
}

export function decisionOfKey(key: unknown): number | undefined {
  const match = typeof key === 'string' ? DECISION_SUFFIX.exec(key) : null
  return match === null ? undefined : Number(match[1])
}

export function answerDecisionOfKey(queue: Queue, key: unknown): number | undefined {
  return queue === 'answer' ? decisionOfKey(key) : undefined
}

export interface CardSql {
  cardBody: (card: string) => string
  latestTurn: (card: string) => string
  notAWindowCard: (card: string) => string
  downgradeWaitOpenOn: (card: string) => string
}

const A_STOP_AN_ANSWER_TASK_WROTE_ON_A_PR = `EXISTS (
  SELECT 1 FROM tasks AS writer WHERE writer.queue = 'answer' AND writer.pr IS NOT NULL AND writer.task_key NOT LIKE '%:stop-%'
    AND stop.dedupe_key = '${CARD_STOPPED}:' || writer.task_key || ':' || writer.lease_gen
)`

const A_LIVE_TASK_OF_THE_DECISION = `EXISTS (
  SELECT 1 FROM tasks AS continued WHERE continued.queue = 'answer' AND continued.card_id = named.card_id
    AND continued.task_key LIKE '%:decision-' || named.decision_id AND continued.state NOT IN (${ENDED_WITHOUT_RUNNING})
)`

export function cardDecisionTurnQuery(sql: CardSql): string {
  return `
  SELECT named.decision_id AS decision, decided.id AS decided_at, named.card_id AS card_id, prs.pr AS pr, prs.head AS head,
    ${sql.cardBody('named.card_id')} AS card_body,
    (SELECT max(reviewed.id) FROM events AS reviewed WHERE reviewed.type = '${REVIEW_RECORDED}' AND reviewed.legacy = 0 AND reviewed.pr = prs.pr) AS last_review,
    (SELECT stop.id FROM events AS stop WHERE stop.id = ${sql.latestTurn('named.card_id')} AND stop.type = '${CARD_STOPPED}'
      AND json_extract(stop.payload, '$.reason') = '${QUESTION_OWNER}' AND stop.id < decided.id AND NOT ${A_STOP_AN_ANSWER_TASK_WROTE_ON_A_PR}) AS owner_stop
  FROM (SELECT CAST(? AS INTEGER) AS decision_id, CAST(? AS INTEGER) AS card_id) AS named
  JOIN events AS decided ON decided.type = '${DECISION_RECORDED}' AND decided.legacy = 0 AND decided.dedupe_key = '${DECISION_RECORDED}:' || named.decision_id
  LEFT JOIN prs ON prs.pr = (SELECT max(open.pr) FROM prs AS open WHERE open.card_id = named.card_id AND open.state = 'open')
  WHERE ${sql.notAWindowCard('named.card_id')} AND NOT ${sql.downgradeWaitOpenOn('named.card_id')}
    AND NOT ${A_LIVE_TASK_OF_THE_DECISION}
`
}

export interface CardDecisionTurn {
  decision: number
  decided_at: number
  card_id: number
  pr: number | null
  head: string | null
  card_body: unknown
  last_review: number | null
  owner_stop: number | null
}

export type PastTheRoundLimit = (pr: number, head: string | null) => boolean

export function continuesTheCard(turn: CardDecisionTurn, pastTheLimit: PastTheRoundLimit): boolean {
  if (turn.owner_stop !== null)
    return true
  return turn.pr !== null && turn.decided_at > (turn.last_review ?? 0) && pastTheLimit(turn.pr, turn.head)
}

export interface DecidedTask {
  decision?: number
}

export interface DecidedContinuations {
  decisions: readonly BoundDecision[]
  sql: CardSql
  pastTheLimit: PastTheRoundLimit
  cardBodyOf: (turn: CardDecisionTurn) => string | undefined
}

export function decidedContinuations(db: DatabaseSync, how: DecidedContinuations): QueuedTask[] {
  const bound = how.decisions.filter(decision => decision.cards.length > 0)
  if (bound.length === 0)
    return []
  const turnOf = db.prepare(cardDecisionTurnQuery(how.sql))
  return bound
    .flatMap(decision => decision.cards.flatMap(card => turnOf.all(decision.decisionId, card) as unknown as CardDecisionTurn[]))
    .filter(turn => continuesTheCard(turn, how.pastTheLimit))
    .map(turn => ({ queue: 'answer', cardId: turn.card_id, pr: turn.pr ?? undefined, head: turn.head ?? undefined, cardBody: how.cardBodyOf(turn), decision: turn.decision }))
}

const CARDS_WITH_A_LIVE_ANSWER = `SELECT DISTINCT card_id FROM tasks WHERE queue = 'answer' AND state IN ('queued', 'leased')`

export function oneContinuationPerCard(db: DatabaseSync, planned: readonly QueuedTask[], decided: readonly QueuedTask[]): QueuedTask[] {
  const answered = new Set([...planned.map(task => task.cardId), ...(db.prepare(CARDS_WITH_A_LIVE_ANSWER).all() as { card_id: number }[]).map(row => Number(row.card_id))])
  const first = new Map<number, QueuedTask>()
  for (const task of decided) {
    if (!answered.has(task.cardId) && !first.has(task.cardId))
      first.set(task.cardId, task)
  }
  return [...first.values()]
}

export function withDecidedContinuations(db: DatabaseSync, planned: readonly QueuedTask[], how: DecidedContinuations): QueuedTask[] {
  const decided = decidedContinuations(db, how)
  return decided.length === 0 ? [...planned] : [...planned, ...oneContinuationPerCard(db, planned, decided)]
}
