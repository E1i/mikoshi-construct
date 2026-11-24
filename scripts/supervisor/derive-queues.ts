import type { DatabaseSync } from 'node:sqlite'
import type { CardOfStop } from '../core/card-readings.js'
import type { EventRow } from '../core/events-query.js'
import type { BoundDecision } from '../core/identifiers.js'
import type { CandidateRules, Derived, MayRequeue, QuestionAnswered, QueuedTask, QueueSource, RequeueRow, TaskRow } from '../core/queue.js'
import type { TaskRow as StoredTask } from '../core/tasks-query.js'
import { isBackfill } from '../core/backfill-source.js'
import { cardsAmong, openWaitEventsByCard, standingStopOf, waitStatesAmong } from '../core/card-readings.js'
import { appendEvent, inTransaction, OPEN_WAIT, openOwnerWait } from '../core/db.js'
import { byId, EITHER_JOURNAL, events, latest } from '../core/events-query.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, CARD_WAITING, declaredPart, MERGE_DONE, OWNER_WAIT_OPENED, POLICY_DENIED, PR_CLOSED, PR_OPENED, QUESTION_AGENT, QUESTION_OWNER, REVIEW_ROUNDS_SPENT, ROUND_MUTATIONS_PARKED, TASK_FAILED, TASK_REQUEUED, TASK_WITHDRAWN, WITNESS_DOWNGRADE } from '../core/events.js'
import { tasksTheHeadOrTheCardDecisionSupersedes } from '../core/identifiers.js'
import { ADMIT_COMMAND } from '../core/owner-commands.js'
import { answersOfAnOldCardBody, COMPLETED, deriveQueues, DOWNGRADE_WAIT_OPEN, FAILURES_TO_STOP, FAULT, identityOfRow, keyOf, LAUNCH_STOP_WITH_NO_PULL_REQUEST, LEASED, openCandidates, QUEUE_ACTOR, QUEUED, reviewsOfAnOldInput, reviewsOfTheCurrentInputAgain, STOPPED, SUPERSEDED, supersedeTask, WITHDRAWN, withdrawTask } from '../core/queue.js'
import * as tasks from '../core/tasks-query.js'

export const LIFTED_ADMISSION = 'lifted'
export const RECUT_GRACE_MS = 10 * 60 * 1000
const NO_CARD_TREE = 'no_card_tree'
const LEGACY_START = 'path'
const OPEN = 'open'
const CLOSED = 'closed'
const MERGED = 'merged'
const ENDED_CARD_STATES = new Set([CLOSED, 'dropped'])
const UNFINISHED = new Set([QUEUED, LEASED, STOPPED])
const LIVE = new Set([QUEUED, LEASED])
const KEYED_ON_THE_HEAD = new Set(['merge', 'update'])
const STILL_NEEDED_AFTER_A_MERGE = new Set(['merge', 'close', 'witness'])
const CARD_TURNS = [CARD_STOPPED, CARD_ANSWERED, CARD_STARTED]
const JSON_TRUE: readonly unknown[] = [1, true]

export interface QueuePr {
  pr: number
  card_id: number | null
  head: string | null
  state: string | null
  ci: string | null
  verdict_on_head: string | null
  body_sha: string | null
}

export interface QueuePrs {
  all: (db: DatabaseSync) => QueuePr[]
  ofPr: (db: DatabaseSync, pr: number) => QueuePr | null
  mainsSinceLastMechanics: (db: DatabaseSync) => { mechanics: string, shas: ReadonlySet<string> } | null
}

export interface QueuePass {
  prs: QueuePrs
  sources: readonly QueueSource[]
  mayRequeue: MayRequeue
  decisionsAt: (db: DatabaseSync, ts: string) => readonly BoundDecision[]
  held: <T>(db: DatabaseSync, ts: string, work: () => T) => T
}

interface Readings {
  tasks: StoredTask[]
  prs: Map<number, QueuePr>
  reads: QueuePrs
}

function readingsOf(db: DatabaseSync, prs: QueuePrs): Readings {
  return { tasks: tasks.all(db), prs: new Map(prs.all(db).map(pr => [pr.pr, pr])), reads: prs }
}

function prOf(readings: Readings, task: { pr: number | null }): QueuePr | undefined {
  return task.pr === null ? undefined : readings.prs.get(task.pr)
}

function onTheHead(pr: QueuePr | undefined, task: StoredTask): boolean {
  return pr !== undefined && pr.head !== null && pr.head === task.head
}

function onTheOpenHead(pr: QueuePr | undefined, task: StoredTask): boolean {
  return pr?.state === OPEN && onTheHead(pr, task)
}

function rowOfTask(task: StoredTask): TaskRow {
  return { task_key: task.task_key, queue: task.queue as TaskRow['queue'], card_id: task.card_id, pr: task.pr, head: task.head }
}

function byTaskKey<Row extends TaskRow>(rows: Row[]): Row[] {
  return rows.sort((a, b) => a.task_key < b.task_key ? -1 : a.task_key > b.task_key ? 1 : 0)
}

function sqlValue(value: unknown): unknown {
  if (value === undefined)
    return null
  if (typeof value === 'boolean')
    return value ? 1 : 0
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : value
}

function jsonEachValues(value: unknown): unknown[] {
  if (value === undefined)
    return []
  if (Array.isArray(value))
    return value
  return typeof value === 'object' && value !== null ? Object.values(value) : [value]
}

const CHAINS = 'SELECT card_id, sha, state FROM chains ORDER BY dir'

interface RestartTarget {
  card_id: number
  head: string
}

function restartTargets(db: DatabaseSync, prs: QueuePrs): RestartTarget[] {
  const mains = prs.mainsSinceLastMechanics(db)
  return (db.prepare(CHAINS).all() as { card_id: number, sha: string, state: string }[]).flatMap((chain) => {
    const mechanics = mains !== null && !mains.shas.has(chain.sha) ? mains.mechanics : null
    return chain.state !== 'stopped' && (mechanics !== null || chain.state === FAULT) ? [{ card_id: Number(chain.card_id), head: mechanics ?? String(chain.sha) }] : []
  })
}

type OldHeadRow = TaskRow & { head_moved: number }

function tasksOfAnOldHead(db: DatabaseSync, readings: Readings): OldHeadRow[] {
  const rows = new Map<string, OldHeadRow>()
  const add = (row: OldHeadRow): void => {
    rows.set(JSON.stringify(row), row)
  }
  for (const task of readings.tasks) {
    const pr = prOf(readings, task)
    if (pr === undefined || !UNFINISHED.has(task.state) || task.head === null || (task.queue === 'answer' && task.state === LEASED))
      continue
    const moved = pr.head !== null && task.head !== pr.head
    if (moved || KEYED_ON_THE_HEAD.has(task.queue))
      add({ ...rowOfTask(task), head_moved: moved ? 1 : 0 })
  }
  const restarts = readings.tasks.filter(task => task.queue === 'restart' && LIVE.has(task.state))
  const targets = restarts.length === 0 ? [] : restartTargets(db, readings.reads)
  for (const task of restarts) {
    const heads = targets.filter(target => target.card_id === task.card_id).map(target => target.head)
    if (heads.length === 0 || (task.head !== null && !heads.includes(task.head)))
      add({ ...rowOfTask(task), head_moved: 1 })
  }
  return byTaskKey([...rows.values()])
}

function mergesOfAnOldBody(readings: Readings): TaskRow[] {
  return byTaskKey(readings.tasks.filter((task) => {
    const bodySha = prOf(readings, task)?.body_sha ?? null
    return task.queue === 'merge' && LIVE.has(task.state) && onTheHead(prOf(readings, task), task) && bodySha !== null
      && !`${task.task_key}:`.includes(`:pr-body-${bodySha}:`)
  }).map(rowOfTask))
}

function closeDenialsOnAWitness(db: DatabaseSync): EventRow[] {
  return events(db, { types: [POLICY_DENIED] }).filter(denied => denied.data?.reason === 'witness' && denied.data.command === 'close')
}

function deniedOnThisWitness(denials: readonly EventRow[], task: StoredTask): boolean {
  return denials.some((denied) => {
    const base = denied.data?.base
    return denied.card_id === task.card_id && task.head !== null && denied.head === task.head && base !== undefined && base !== null
      && task.task_key.includes(`:base-${String(base)}`)
  })
}

function tasksOfAClosedPullRequest(db: DatabaseSync, readings: Readings, ts: string): TaskRow[] {
  const ofClosedPrs = readings.tasks.filter(task => UNFINISHED.has(task.state) && [CLOSED, MERGED].includes(prOf(readings, task)?.state ?? ''))
  if (ofClosedPrs.length === 0)
    return []
  const closedCards = new Set(events(db, { types: [CARD_CLOSED], legacy: EITHER_JOURNAL }).map(closed => closed.card_id))
  const denials = closeDenialsOnAWitness(db)
  const stillNeeded = (task: StoredTask): boolean =>
    (STILL_NEEDED_AFTER_A_MERGE.has(task.queue) && task.state === LEASED && (task.lease_until === null || task.lease_until >= ts))
    || (!closedCards.has(task.card_id) && (task.queue === 'close' || (task.queue === 'witness' && deniedOnThisWitness(denials, task))))
  return byTaskKey(ofClosedPrs.filter(task => prOf(readings, task)?.state === CLOSED || !stillNeeded(task)).map(rowOfTask))
}

function supersededMergesAndUpdatesOnTheCurrentHead(readings: Readings): RequeueRow[] {
  const live = new Set(readings.tasks.filter(task => LIVE.has(task.state) && task.pr !== null).map(task => `${task.queue}:${task.pr}`))
  return byTaskKey(readings.tasks.filter(task => KEYED_ON_THE_HEAD.has(task.queue) && task.state === SUPERSEDED && onTheOpenHead(prOf(readings, task), task)
    && !live.has(`${task.queue}:${task.pr}`)).map(task => ({ ...rowOfTask(task), failure: task.event_id })))
}

const CAUSE_GONE_ON: Record<string, (gone: EventRow) => boolean> = {
  no_verification: gone => gone.type === CARD_VERIFIED && !gone.legacy,
  no_merge_commit: gone => gone.type === MERGE_DONE || (gone.type === PR_CLOSED && JSON_TRUE.includes(gone.data?.merged)),
}

function alarmsWhoseCauseIsGone(db: DatabaseSync, readings: Readings): RequeueRow[] {
  const stopped = readings.tasks.filter(task => task.state === STOPPED)
  if (stopped.length === 0)
    return []
  const alarmed = new Set(events(db, { types: [BOARD_ALARM], legacy: EITHER_JOURNAL }).map(alarm => alarm.data?.task_key))
  return byTaskKey(stopped.flatMap((task): RequeueRow[] => {
    const pr = prOf(readings, task)
    if (!alarmed.has(task.task_key) || (task.pr !== null && (pr?.state === CLOSED || !onTheHead(pr, task))))
      return []
    const stop = byId(db, task.event_id)
    const cause = stop?.data?.reason
    const gone = typeof cause === 'string' && Object.hasOwn(CAUSE_GONE_ON, cause) ? CAUSE_GONE_ON[cause]! : undefined
    if (stop === null || gone === undefined)
      return []
    const attempts = events(db, { types: [TASK_REQUEUED], task: task.task_key, legacy: EITHER_JOURNAL }).filter(again => again.data?.cause === cause).length
    const after = events(db, { card: task.card_id, since: stop.id, legacy: EITHER_JOURNAL }).filter(event => event.pr === task.pr && gone(event))
    return attempts < FAILURES_TO_STOP && after.length > 0 ? [{ ...rowOfTask(task), failure: after[0]!.id, cause: cause as string }] : []
  }))
}

function cardTreeCanBeBroughtUp(db: DatabaseSync, readings: Readings, cardId: number): boolean {
  if ([...readings.prs.values()].some(pr => pr.card_id === cardId && pr.state === OPEN))
    return true
  return events(db, { card: cardId, types: [CARD_STARTED, LEGACY_START], legacy: EITHER_JOURNAL }).some(start =>
    ((start.type === CARD_STARTED && !start.legacy) || (start.type === LEGACY_START && start.legacy))
    && typeof start.data?.worktree === 'string' && typeof start.data.branch === 'string')
}

function stoppedOnNoCardTree(db: DatabaseSync, prs: QueuePrs): RequeueRow[] {
  const readings = readingsOf(db, prs)
  return byTaskKey(readings.tasks.filter(task => task.queue === 'answer' && task.state === STOPPED && (task.pr === null || onTheOpenHead(prOf(readings, task), task)))
    .filter(task => byId(db, task.event_id)?.data?.reason === NO_CARD_TREE && cardTreeCanBeBroughtUp(db, readings, task.card_id))
    .map(task => ({ ...rowOfTask(task), failure: task.event_id })))
}

interface StoppedAnswerRow extends RequeueRow {
  failures: number
}

function answeredAt(db: DatabaseSync, answered: QuestionAnswered): (stop: number) => boolean {
  const query = db.prepare(`SELECT ${answered('stop')} AS answered FROM (SELECT ? AS id) AS stop`)
  return stop => (query.get(stop) as { answered: number | null }).answered === 1
}

function answersWhoseStopNoLongerHold(db: DatabaseSync, prs: QueuePrs, answered: QuestionAnswered): StoppedAnswerRow[] {
  const readings = readingsOf(db, prs)
  const isAnswered = answeredAt(db, answered)
  return byTaskKey(readings.tasks.flatMap((task): StoppedAnswerRow[] => {
    if (task.queue !== 'answer' || task.state !== COMPLETED || task.task_key.toLowerCase().includes(':stop-') || !onTheOpenHead(prOf(readings, task), task))
      return []
    return events(db, { keys: [`${CARD_STOPPED}:${task.task_key}:${task.lease_gen}`], legacy: EITHER_JOURNAL }).flatMap((stop): StoppedAnswerRow[] => {
      const reason = stop.data?.reason
      const holds = reason === FAULT || (reason === QUESTION_OWNER && isAnswered(stop.id))
      return holds && standingStopOf(db, task.card_id)?.id === stop.id ? [{ ...rowOfTask(task), failures: task.failures, failure: stop.id, fault: reason === FAULT }] : []
    })
  }))
}

function cardsUnderADowngradeWait(db: DatabaseSync): Set<number> {
  const waits = openWaitEventsByCard(db)
  const asked = new Set(events(db, { ids: [...waits.values()].flat(), types: [CARD_WAITING], legacy: EITHER_JOURNAL })
    .filter(wait => wait.data?.reason === WITNESS_DOWNGRADE)
    .map(wait => wait.id))
  return new Set([...waits].filter(([, opened]) => opened.some(id => asked.has(id))).map(([card]) => card))
}

function queuedAnswersUnderADowngradeWait(db: DatabaseSync): TaskRow[] {
  const queued = tasks.ofQueue(db, 'answer').filter(task => task.state === QUEUED)
  const waiting = queued.length === 0 ? new Set<number>() : cardsUnderADowngradeWait(db)
  return byTaskKey(queued.filter(task => waiting.has(task.card_id)).map(rowOfTask))
}

function answersParkedOnADowngradeWaitNowClosed(db: DatabaseSync, prs: QueuePrs): RequeueRow[] {
  const readings = readingsOf(db, prs)
  const parked = readings.tasks.filter(task => task.queue === 'answer' && task.state === WITHDRAWN && (task.pr === null || onTheOpenHead(prOf(readings, task), task)))
    .filter((task) => {
      const event = byId(db, task.event_id)
      return event !== null && [TASK_FAILED, TASK_WITHDRAWN].includes(event.type) && event.data?.reason === DOWNGRADE_WAIT_OPEN
    })
  const waiting = parked.length === 0 ? new Set<number>() : cardsUnderADowngradeWait(db)
  return byTaskKey(parked.filter(task => !waiting.has(task.card_id)).map(task => ({ ...rowOfTask(task), failure: task.event_id })))
}

interface QuestionStop {
  stop: EventRow
  card: number
  cardRow: CardOfStop | undefined
}

function latestQuestionStops(db: DatabaseSync, prs: QueuePrs): QuestionStop[] {
  const latestOfCard = new Map<number, EventRow>()
  for (const stop of events(db, { types: [CARD_STOPPED] })) {
    if (stop.card_id !== null && stop.data?.reason === QUESTION_AGENT)
      latestOfCard.set(stop.card_id, stop)
  }
  const standing = [...latestOfCard].filter(([card, stop]) => standingStopOf(db, card)?.id === stop.id).sort(([a], [b]) => a - b)
  const cards = cardsAmong(db, standing.map(([card]) => card))
  return standing.flatMap(([card, stop]) => {
    const cardRow = cards.get(card)
    const pr = stop.pr ?? cardRow?.pr ?? null
    const state = pr === null ? undefined : prs.ofPr(db, pr)?.state
    return state === undefined || state === OPEN ? [{ stop, card, cardRow }] : []
  })
}

function asksToWidenTheTouches(stop: EventRow): boolean {
  return jsonEachValues(stop.data?.widen).some(widen => typeof widen === 'string' && widen !== '')
}

function admittedAfterTheStop(db: DatabaseSync, question: QuestionStop): boolean {
  return events(db, { card: question.card, types: [CARD_ADMITTED], since: question.stop.id, limit: 1 }).length > 0
}

function askedTheSameQuestionJustBefore(db: DatabaseSync, question: QuestionStop): boolean {
  const before = latest(db, { card: question.card, types: CARD_TURNS, before: question.stop.id })
  return before?.type === CARD_STOPPED && before.data?.reason === QUESTION_AGENT
    && JSON.stringify(sqlValue(before.data.detail)) === JSON.stringify(sqlValue(question.stop.data?.detail))
}

function aQuestionOfTheStopStillOpen(db: DatabaseSync, question: QuestionStop): boolean {
  const opened = events(db, { card: question.card, types: [OWNER_WAIT_OPENED], since: question.stop.id })
  const ids = opened.map(wait => wait.data?.id).filter(id => id !== undefined && id !== null).map(String)
  const states = waitStatesAmong(db, ids)
  return opened.some((wait) => {
    const id = wait.data?.id
    const state = id === undefined || id === null ? undefined : states.get(String(id))
    return state === undefined || state === OPEN_WAIT
  })
}

function latestAdmission(db: DatabaseSync, cardId: number): EventRow | undefined {
  return events(db, { card: cardId, types: [CARD_ADMITTED], newestFirst: true }).find(admitted => admitted.data === null || !isBackfill(admitted.data))
}

function launchStopsLifted(db: DatabaseSync, prs: QueuePrs): { card_id: number, stop: number, admission: string | null }[] {
  return latestQuestionStops(db, prs).filter(question =>
    question.stop.pr === null && question.stop.dedupe_key.startsWith(LAUNCH_STOP_WITH_NO_PULL_REQUEST)
    && !asksToWidenTheTouches(question.stop) && !admittedAfterTheStop(db, question) && !aQuestionOfTheStopStillOpen(db, question)
    && !ENDED_CARD_STATES.has(question.cardRow?.state ?? ''),
  ).map(question => ({ card_id: question.card, stop: question.stop.id, admission: latestAdmission(db, question.card)?.payload ?? null }))
}

interface WindowQuestionRow {
  card_id: number
  pr: number | null
  widen: number
  detail: unknown
  lane: unknown
}

function questionsWithNoWindowWaitYet(db: DatabaseSync, prs: QueuePrs): WindowQuestionRow[] {
  return latestQuestionStops(db, prs).filter((question) => {
    const amendsFirst = (asksToWidenTheTouches(question.stop) || askedTheSameQuestionJustBefore(db, question)) && !admittedAfterTheStop(db, question)
    return amendsFirst && events(db, { card: question.card, types: [OWNER_WAIT_OPENED], since: question.stop.id, legacy: EITHER_JOURNAL, limit: 1 }).length === 0
  }).map(question => ({
    card_id: question.card,
    pr: question.stop.pr ?? question.cardRow?.pr ?? null,
    widen: asksToWidenTheTouches(question.stop) ? 1 : 0,
    detail: sqlValue(question.stop.data?.detail),
    lane: sqlValue(latest(db, { card: question.card, types: [CARD_ADMITTED] })?.data?.lane),
  }))
}

function roundLimitsWithNoOutcome(db: DatabaseSync, prs: QueuePrs, settled: string): { card_id: number | null, pr: number }[] {
  const spent = events(db, { types: [REVIEW_ROUNDS_SPENT] }).filter(event => event.ts <= settled && event.pr !== null && prs.ofPr(db, event.pr)?.state === OPEN)
  if (spent.length === 0)
    return []
  const recut = new Set(events(db, { types: [PR_OPENED], mentions: 'recut_of', legacy: EITHER_JOURNAL }).map(opened => opened.data?.recut_of))
  return spent.filter((event) => {
    const pr = event.pr!
    return !recut.has(pr)
      && events(db, { pr, types: [OWNER_WAIT_OPENED], since: event.id, legacy: EITHER_JOURNAL, limit: 1 }).length === 0
      && events(db, { pr, types: [ROUND_MUTATIONS_PARKED], limit: 1 }).length === 0
  }).map(event => ({ card_id: event.card_id, pr: event.pr! })).sort((a, b) => a.pr - b.pr)
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

function openLostRecutWaits(db: DatabaseSync, ts: string, prs: QueuePrs): void {
  const settled = new Date(Date.parse(ts) - RECUT_GRACE_MS).toISOString()
  for (const row of roundLimitsWithNoOutcome(db, prs, settled))
    inTransaction(db, () => openOwnerWait(db, ts, QUEUE_ACTOR, { need: 'decision', text: lostRecutWaitText(row.card_id as number, row.pr), card: row.card_id as number, pr: row.pr }))
}

function openWindowWaits(db: DatabaseSync, ts: string, prs: QueuePrs): void {
  for (const row of questionsWithNoWindowWaitYet(db, prs))
    inTransaction(db, () => openOwnerWait(db, ts, QUEUE_ACTOR, { need: 'command', text: windowWaitText(row), command: admitCommandOf(row.card_id, row.lane), card: row.card_id, ...(row.pr === null ? {} : { pr: row.pr }) }))
}

function readmitLiftedLaunchStops(db: DatabaseSync, ts: string, prs: QueuePrs): void {
  for (const row of launchStopsLifted(db, prs)) {
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

export function noCardTreeSource(prs: QueuePrs): QueueSource {
  return { queue: 'answer', requeue: db => stoppedOnNoCardTree(db, prs) }
}

export function downgradeParkedSource(prs: QueuePrs): QueueSource {
  return { queue: 'answer', requeue: db => answersParkedOnADowngradeWaitNowClosed(db, prs) }
}

export function dueAgainSource(prs: QueuePrs, candidates: (db: DatabaseSync, ts: string) => QueuedTask[]): QueueSource {
  return {
    requeue: (db, ts) => {
      const due = new Set(candidates(db, ts).map(keyOf))
      return [...reviewsOfTheCurrentInputAgain(db, prs.all(db)), ...supersededMergesAndUpdatesOnTheCurrentHead(readingsOf(db, prs)).filter(row => due.has(row.task_key))]
    },
  }
}

export function causeGoneSource(prs: QueuePrs, reopened: (db: DatabaseSync, ts: string) => RequeueRow[]): QueueSource {
  return { requeue: (db, ts) => [...alarmsWhoseCauseIsGone(db, readingsOf(db, prs)), ...reopened(db, ts)] }
}

export function stopNoLongerHoldsSource(prs: QueuePrs, answered: QuestionAnswered): QueueSource {
  return {
    queue: 'answer',
    requeue: (db, ts) => answersWhoseStopNoLongerHold(db, prs, answered).flatMap((row): RequeueRow[] => {
      if (row.fault === true && row.failures + 1 >= FAILURES_TO_STOP) {
        alarmed(db, ts, row)
        return []
      }
      return [row]
    }),
  }
}

export function settleSource(prs: QueuePrs): QueueSource {
  return {
    settle: (db, ts) => {
      for (const row of queuedAnswersUnderADowngradeWait(db))
        withdrawTask(db, ts, identityOfRow(row), DOWNGRADE_WAIT_OPEN)
      openWindowWaits(db, ts, prs)
      readmitLiftedLaunchStops(db, ts, prs)
      openLostRecutWaits(db, ts, prs)
    },
  }
}

export function restartSource(prs: QueuePrs, rules: CandidateRules): QueueSource {
  return { queue: 'restart', enqueue: (db, ts) => openCandidates(db, ts, 'restart', restartTargets(db, prs).map(target => ({ pr: null, card_id: target.card_id, head: target.head })), rules) }
}

function supersededAndWithdrawn(db: DatabaseSync, ts: string, pass: QueuePass): string[] {
  const superseded: string[] = []
  for (const row of tasksTheHeadOrTheCardDecisionSupersedes(tasksOfAnOldHead(db, readingsOf(db, pass.prs)), pass.decisionsAt(db, ts), identityOfRow)) {
    if (supersedeTask(db, ts, identityOfRow(row)))
      superseded.push(row.task_key)
  }
  for (const row of tasksOfAClosedPullRequest(db, readingsOf(db, pass.prs), ts))
    withdrawTask(db, ts, identityOfRow(row))
  for (const row of [...reviewsOfAnOldInput(db, pass.prs.all(db)), ...answersOfAnOldCardBody(db), ...mergesOfAnOldBody(readingsOf(db, pass.prs))]) {
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
