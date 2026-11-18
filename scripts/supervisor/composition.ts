import type { DatabaseSync } from 'node:sqlite'
import type { CardAutomaton, CardCondition, CardMover } from '../ci/card-automaton.js'
import type { Understood } from '../core/bus-version.js'
import type { SliceParentsBackfill } from '../core/card-bodies.js'
import type { CardTransitions, HolderStart, Lease } from '../core/lease.js'
import type { NodeKind, NodeSupply, ProcessIdentity, WorkerIdentity } from '../core/node.js'
import type { CandidateRules, Derived, MayRequeue, QueueSource, RequeueRow } from '../core/queue.js'
import type { Projections } from '../core/reducer.js'
import type { Fold, StoredEvent } from '../core/stored.js'
import type { AnswerParts } from '../nodes/answer/answer-candidates.js'
import type { MergeParts } from '../nodes/merge/merge-candidates.js'
import type { DriftWatch } from '../nodes/merge/weights-drift.js'
import type { UpdateSourceParts } from '../nodes/update/update-candidates.js'
import type { DerivedHolds, ThresholdSet } from '../nodes/update/update-executor.js'
import type { WitnessParts } from '../nodes/witness/witness-candidates.js'
import type { InForceDecision } from '../policy/decisions/index.js'
import type { GitHub } from '../ports/github.js'
import type { PlanParts } from '../window/plan-folds.js'
import type { CardWaitParts } from './card-waits.js'
import type { DeadEndEvents, DeadEndParts } from './dead-ends.js'
import type { QueuePass } from './derive-queues.js'
import type { SpoolPlaces } from './gate-run-spool.js'
import type { SessionMeasure } from './heartbeat.js'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import process from 'node:process'
import { PRIORITIES, WINDOW_WHO } from '../../src/card/parking.js'
import { witnessesOf } from '../../src/commands/intake/admit.js'
import { automatonOf, moversOf } from '../ci/card-automaton.js'
import { GATE_RUN_SPOOL } from '../ci/gate-runs.js'
import { driftOfRun } from '../ci/weights-law.js'
import { appendedOnCard, CARD_FOLDS, cardLinkObserved, cardPrMerged, cardPrOpened, CARDS_PROJECTION, CHANGES_CARD, CLOSED_CARD, DEFERRED_CARD, DROPPED_CARD, FALLEN_CARD, IN_REVIEW_CARD, MERGED_CARD, QUEUED_CARD, READY_CARD, RUNNING_CARD, STOPPED_CARD } from '../core/card-automaton.js'
import { admittedCardVersion, backfillPendingSliceParents, cardOfBranch } from '../core/card-bodies.js'
import { cardDecisionReads, reviewedUnderTheCardDecision, reviewsTheCardDecisionReopens, withDecidedContinuations } from '../core/card-decisions.js'
import { CHAINS_PROJECTION } from '../core/chain.js'
import { CARD_PLANNED, CARD_STOPPED, CARD_UNPLANNED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED, PR_OBSERVED, PR_OPENED, QUESTION_OWNER, RATCHET_THRESHOLD_SET, SLICE_PARENTS_BACKFILLED } from '../core/events.js'
import { isFullSha, prOf } from '../core/identifiers.js'
import { OWNER, ownerQuestionAnswered } from '../core/inbox.js'
import { foreignVersion, instanceOf, provenIdentity, recordWorkerIdentity, UNHANDED } from '../core/node.js'
import { orderDeclarationsAt, overlaps } from '../core/order/overlap.js'
import { ownerWaitCommand } from '../core/owner-commands.js'
import { prFolds, prRow } from '../core/pr-folds.js'
import { keyOf, reviewCandidates, taskRow, TASKS_PROJECTION } from '../core/queue.js'
import { ownerWaitFolds } from '../core/reducer.js'
import { payloadOf, storedByKey } from '../core/stored.js'
import { BusWeightsRecompute } from '../intake/intake.js'
import { answerSource } from '../nodes/answer/answer-candidates.js'
import { LAUNCH_SOURCE } from '../nodes/launch/launch-candidates.js'
import { handFile } from '../nodes/launch/launch-starter.js'
import { mergeCandidates, mergeSource } from '../nodes/merge/merge-candidates.js'
import { WeightsDriftWatch } from '../nodes/merge/weights-drift.js'
import { ROLES_PROJECTION } from '../nodes/restart/role.js'
import { updateCandidates, updateSource } from '../nodes/update/update-candidates.js'
import { witnessSource } from '../nodes/witness/witness-candidates.js'
import { archiveSpentDecisions, DECISION_FOLDS } from '../policy/decisions/index.js'
import { answersOfTheDecisions } from '../policy/decisions/wait-folds.js'
import { mayRequeueUnderTheRounds, mergeDecidedPastRoundLimit, outOfRounds, RECUT_ACTOR, REVIEWS_OF_A_PR } from '../policy/round-limit-decision.js'
import { decisionsInForceAt, unspentShardsOf, WINDOW_SHARDS_LIVE_AT, withDecisionsHeldAt } from '../policy/shards.js'
import { derivedHoldOf } from '../policy/touch-scope.js'
import { ANY, BusRead } from '../ports/bus-read.js'
import { cardTreeReading } from '../ports/card-tree.js'
import { GhCiRuns } from '../ports/ci-reading.js'
import { CHECK_MS, TICK_MS } from '../ports/netwatch.js'
import { launchDirOf } from '../ports/tree-publish.js'
import { cardTreeRoots } from '../ports/worktree-home.js'
import { foldPlanEvent } from '../window/plan-folds.js'
import { releasingTakeoverOnPush } from '../window/takeover-push-release.js'
import { cardWaitFolds, closeWaitsOfAnEndedCard, closingTheWaitsOfAClosedPr } from './card-waits.js'
import { causeGoneSource, derivedQueues, DOWNGRADE_PARKED_SOURCE, dueAgainSource, NO_CARD_TREE_SOURCE, restartSource, SETTLE_SOURCE, stopNoLongerHoldsSource } from './derive-queues.js'
import { busSessionPulse, heartbeatEnv, measureCardSession, ownStart, recordProcessHeartbeat } from './heartbeat.js'
import { SILENT_MS } from './liveness-sites.js'
import { ownIdentity, tableIdentity } from './recorded-worker.js'
import { slotsOf, slotsVariable } from './scheduler.js'

export interface NodeLiveness {
  silentMs: number
}

export function workerIdentity(worker: string, start: HolderStart, env: NodeJS.ProcessEnv = process.env, own: () => ProcessIdentity | null = ownIdentity): WorkerIdentity {
  return { worker, pid: start.pid, started: start.started, ...instanceOf(env), ...provenIdentity(start, own()) }
}

export function recordOwnStart(db: DatabaseSync, kind: string, env: NodeJS.ProcessEnv = process.env, own: () => ProcessIdentity | null = ownIdentity): boolean {
  try {
    const { instance } = instanceOf(env)
    const worker = `worker:${kind}:${instance === UNHANDED ? randomUUID() : instance}`
    return recordWorkerIdentity(db, new Date().toISOString(), workerIdentity(worker, ownStart(), env, own))
  }
  catch {
    return false
  }
}

export function mainOverlapAt(root: string): (pr: readonly string[], main: readonly string[]) => boolean {
  return (pr, main) => overlaps(pr, main, orderDeclarationsAt(root))
}

export function nodeLiveness(): NodeLiveness {
  return { silentMs: SILENT_MS }
}

export type CardSessionMeasure = SessionMeasure

export function refusesForeignCard(db: DatabaseSync, lease: Lease, understands: Understood): string | null {
  const version = admittedCardVersion(db, lease.cardId)
  return version === null ? null : foreignVersion(understands, 'card', version, `card #${lease.cardId} (${lease.taskKey})`)
}

export function cardTransitions(): CardTransitions {
  return { appendedOnCard }
}

export function nodeSupply(): NodeSupply {
  return {
    cards: cardTransitions(),
    cadence: { checkMs: CHECK_MS, tickMs: TICK_MS },
    recordProcessHeartbeat,
    slotsOf: (kind: NodeKind, env: NodeJS.ProcessEnv) => slotsOf(kind, env),
    ownStart,
    ownIdentity: () => ownIdentity(),
    identityOf: tableIdentity(),
    refuses: refusesForeignCard,
  }
}

export function withSlots(kind: NodeKind, env: NodeJS.ProcessEnv, slots: number): NodeJS.ProcessEnv {
  return { ...env, [slotsVariable(kind)]: String(slots) }
}

export function cardSessionPulse(busPath: string, clock: () => Date, measure: CardSessionMeasure = measureCardSession): (lease: Lease, session: string) => string {
  return busSessionPulse(busPath, clock, measure)
}

export function launchSessionEnv(cardId: number): Record<string, string> {
  return heartbeatEnv({ cardId, pr: null, head: null, queue: 'launch' })
}

const PLAN_PARTS: PlanParts = { owner: OWNER, recut: RECUT_ACTOR, payloadOf }

function foldPlanByItsActors(db: DatabaseSync, event: StoredEvent): void {
  foldPlanEvent(db, event, PLAN_PARTS)
}

const PLAN_FOLDS: Record<string, Fold> = {
  [PLAN_OPENED]: foldPlanByItsActors,
  [PLAN_ITEM_ADDED]: foldPlanByItsActors,
  [PLAN_ITEM_LINKED]: foldPlanByItsActors,
  [PLAN_ITEM_REMOVED]: foldPlanByItsActors,
  [PLAN_CLOSED]: foldPlanByItsActors,
  [CARD_PLANNED]: foldPlanByItsActors,
  [CARD_UNPLANNED]: foldPlanByItsActors,
  [PLAN_BACKFILLED]: foldPlanByItsActors,
}

export function ratchetThresholdSets(db: DatabaseSync): (cardId: number) => ThresholdSet[] {
  const read = new BusRead(db)
  return cardId => read.where({ card: cardId }).slice(RATCHET_THRESHOLD_SET, ['decision', 'row', 'to']).flatMap(({ fields: { decision, row, to } }) =>
    typeof decision === 'string' && typeof row === 'string' && typeof to === 'number' ? [{ decision, row, to }] : [])
}

export function derivedHolds(db: DatabaseSync): DerivedHolds {
  return (cardId, scope, files) => derivedHoldOf(scope, files, () => cardTreeReading(db, cardId))
}

function cardWaitParts(): CardWaitParts {
  return { archiveSpentDecisions, prRow }
}

export function busPrFolds(): Record<string, Fold> {
  return prFolds({
    transitions: { linkObserved: cardLinkObserved, prMerged: cardPrMerged, prOpened: cardPrOpened },
    fields: { isFullSha, prOf },
    cardOfBranch,
    closed: closingTheWaitsOfAClosedPr(cardWaitParts()),
  })
}

export function busOwnerWaitFolds(): Record<string, Fold> {
  return ownerWaitFolds({ commandOf: ownerWaitCommand, decisionFolds: DECISION_FOLDS, answersOfTheDecisions, closeWaitsOfAnEndedCard })
}

export function busProjections(): Projections {
  return {
    folds: [releasingTakeoverOnPush(busPrFolds(), [PR_OBSERVED, PR_OPENED], db => new BusRead(db)), TASKS_PROJECTION.folds, CHAINS_PROJECTION.folds, ROLES_PROJECTION.folds, DECISION_FOLDS, CARD_FOLDS, busOwnerWaitFolds(), PLAN_FOLDS, cardWaitFolds(cardWaitParts())],
    incremental: [ROLES_PROJECTION, TASKS_PROJECTION, CHAINS_PROJECTION, CARDS_PROJECTION],
  }
}

function decisionsAt(db: DatabaseSync, ts: string): InForceDecision[] {
  return decisionsInForceAt(db, new Date(ts))
}

export function candidateRules(): CandidateRules {
  return {
    mayRequeue: mayRequeueUnderTheRounds,
    decisionsAt,
    mergeDecided: mergeDecidedPastRoundLimit,
    outOfRounds,
    reviewedUnderTheCardDecision: (db, ts) => reviewedUnderTheCardDecision(cardDecisionReads(db, decisionsAt(db, ts), REVIEWS_OF_A_PR, storedByKey)),
  }
}

export function mayRequeue(): MayRequeue {
  return mayRequeueUnderTheRounds
}

export function witnessParts(): WitnessParts {
  return { rules: candidateRules(), namesWitnesses: row => typeof row.text === 'string' && witnessesOf(row.text).length > 0 }
}

export function mergeParts(): MergeParts {
  return { rules: candidateRules(), laterShards: { named: unspentShardsOf('tasks.card_id', 'tasks.pr'), window: WINDOW_SHARDS_LIVE_AT } }
}

export function answerParts(): AnswerParts {
  return { rules: candidateRules(), answered: ownerQuestionAnswered, continuations: withDecidedContinuations, windowWho: WINDOW_WHO }
}

export function updateParts(): UpdateSourceParts {
  const [topPriority] = PRIORITIES
  return { rules: candidateRules(), topPriority }
}

function reopenedReviews(rules: CandidateRules): (db: DatabaseSync, ts: string) => RequeueRow[] {
  return (db, ts) => reviewsTheCardDecisionReopens(cardDecisionReads(db, decisionsAt(db, ts), REVIEWS_OF_A_PR, storedByKey), reviewCandidates(db, ts, rules), keyOf, key => taskRow(db, key))
}

function on(state: string, ...conditions: string[]): CardCondition[] {
  return conditions.map(condition => ({ state, condition }))
}

function all(...lists: CardCondition[][]): CardCondition[] {
  return lists.flat()
}

const ADMITTED = 'admitted'
const SESSION_LIVE = 'launch session live'
const SESSION_SILENT = 'launch session silent'
const CI_PENDING = 'ci pending'
const CI_RED = 'ci red'
const WITNESS_UNRECORDED = 'witness not recorded on the head'
const WITNESS_RED = 'witness red'
const NO_VERDICT = 'no verdict on the head'
const BEHIND_MAIN = 'behind main'
const MERGE_REFUSED_DIRTY = 'merge refused on a dirty base'
const VERDICT_CHANGES = 'verdict changes'
const VERDICT_PASS = 'verdict pass'
const PR_MERGED = 'pull request merged'
const FELL = 'fell'
const DEFERRED_BY_THE_OWNER = 'deferred by the owner'
const STOP_REASONS = [QUESTION_OWNER, 'question.agent', 'review', 'conflict', 'fault', 'ci'] as const

export function cardAutomaton(): CardAutomaton {
  return automatonOf([QUEUED_CARD, RUNNING_CARD, IN_REVIEW_CARD, CHANGES_CARD, READY_CARD, MERGED_CARD, CLOSED_CARD, FALLEN_CARD, STOPPED_CARD, DROPPED_CARD, DEFERRED_CARD], [CLOSED_CARD, DROPPED_CARD], [
    ...on(QUEUED_CARD, ADMITTED),
    ...on(RUNNING_CARD, SESSION_LIVE, SESSION_SILENT),
    ...on(IN_REVIEW_CARD, CI_PENDING, CI_RED, WITNESS_UNRECORDED, WITNESS_RED, NO_VERDICT, BEHIND_MAIN, MERGE_REFUSED_DIRTY),
    ...on(CHANGES_CARD, VERDICT_CHANGES),
    ...on(READY_CARD, VERDICT_PASS, BEHIND_MAIN),
    ...on(MERGED_CARD, PR_MERGED),
    ...on(STOPPED_CARD, ...STOP_REASONS),
    ...on(FALLEN_CARD, FELL),
    ...on(DEFERRED_CARD, DEFERRED_BY_THE_OWNER),
  ])
}

export interface QueueMover extends CardMover {
  source?: QueueSource
}

export function queueMovers(): QueueMover[] {
  const rules = candidateRules()
  return [
    { node: 'answer', source: NO_CARD_TREE_SOURCE, selects: on(STOPPED_CARD, 'fault') },
    { node: 'witness', source: witnessSource(), selects: on(IN_REVIEW_CARD, WITNESS_UNRECORDED) },
    { node: 'merge', source: mergeSource(mergeParts()), selects: on(READY_CARD, VERDICT_PASS) },
    { node: 'answer', source: DOWNGRADE_PARKED_SOURCE, selects: all(on(CHANGES_CARD, VERDICT_CHANGES), on(IN_REVIEW_CARD, CI_RED)) },
    { node: 'merge', source: dueAgainSource((db, ts) => [...mergeCandidates(db, ts, rules), ...updateCandidates(db, ts, updateParts())]), selects: all(on(READY_CARD, VERDICT_PASS, BEHIND_MAIN), on(IN_REVIEW_CARD, NO_VERDICT, BEHIND_MAIN)) },
    { node: 'update', source: updateSource(updateParts()), selects: all(on(IN_REVIEW_CARD, BEHIND_MAIN), on(READY_CARD, BEHIND_MAIN)) },
    { node: 'review', source: causeGoneSource(reopenedReviews(rules)), selects: on(IN_REVIEW_CARD, NO_VERDICT) },
    { node: 'answer', source: stopNoLongerHoldsSource(ownerQuestionAnswered), selects: on(STOPPED_CARD, QUESTION_OWNER, 'fault') },
    { node: 'window', source: SETTLE_SOURCE, selects: on(STOPPED_CARD, 'question.agent') },
    { node: 'restart', source: restartSource(rules), selects: on(STOPPED_CARD, 'fault') },
    { node: 'answer', source: answerSource(answerParts()), selects: all(on(CHANGES_CARD, VERDICT_CHANGES), on(IN_REVIEW_CARD, CI_RED, WITNESS_RED, MERGE_REFUSED_DIRTY), on(STOPPED_CARD, 'question.agent', 'review', 'conflict', 'ci')) },
    { node: 'launch', source: LAUNCH_SOURCE, selects: all(on(QUEUED_CARD, ADMITTED), on(RUNNING_CARD, SESSION_LIVE), on(FALLEN_CARD, FELL)) },
    { node: 'review', selects: on(IN_REVIEW_CARD, NO_VERDICT) },
    { node: 'close', selects: on(MERGED_CARD, PR_MERGED) },
    { node: 'supervisor', selects: on(RUNNING_CARD, SESSION_SILENT) },
    { node: 'netwatch', selects: on(IN_REVIEW_CARD, CI_PENDING) },
    { node: OWNER, selects: all(on(DEFERRED_CARD, DEFERRED_BY_THE_OWNER), on(STOPPED_CARD, QUESTION_OWNER)) },
  ]
}

export function queueSources(): QueueSource[] {
  return queueMovers().flatMap(mover => mover.source === undefined ? [] : [mover.source])
}

export function deadEndEvents(db: DatabaseSync): DeadEndEvents {
  const read = new BusRead(db)
  return {
    lastStopReason: (card) => {
      const reason = read.where({ card }).slice(CARD_STOPPED, ['reason'], 'last')[0]?.fields.reason
      return typeof reason === 'string' ? reason : null
    },
    cardsOfUnclosedOwnerWaits: () => {
      const closed = new Set(read.slice(OWNER_WAIT_CLOSED, ['id']).map(event => event.fields.id))
      return read.where({ card: ANY }).slice(OWNER_WAIT_OPENED, ['id']).filter(event => !closed.has(event.fields.id)).map(event => event.card!)
    },
    cardsNobodyHolds: (heldElsewhere, ignoredActor) => read.cardsNobodyHolds(heldElsewhere, ignoredActor),
  }
}

export function deadEndParts(db: DatabaseSync): DeadEndParts {
  return { moversOf: cardMoversOf, events: deadEndEvents(db) }
}

export function cardMoversOf(state: string, condition: string | null = null): string[] {
  return moversOf(queueMovers(), state, condition)
}

export function queuePass(): QueuePass {
  return { sources: queueSources(), mayRequeue: mayRequeue(), decisionsAt, held: (db, ts, work) => withDecisionsHeldAt(db, new Date(ts), work) }
}

export function sliceParentsOnce(db: DatabaseSync, ts: string): SliceParentsBackfill | null {
  if (new BusRead(db).slice(SLICE_PARENTS_BACKFILLED, [], 'last').length > 0)
    return null
  return backfillPendingSliceParents(db, ts)
}

export function deriveQueuesOfTheBus(db: DatabaseSync, ts: string): Derived {
  sliceParentsOnce(db, ts)
  return derivedQueues(db, ts, queuePass())
}

export function gateRunSpoolPlaces(env: NodeJS.ProcessEnv, busPath: string, repo: string): SpoolPlaces {
  return { homes: cardTreeRoots(env, busPath, repo).homes, spool: GATE_RUN_SPOOL }
}

export function weightsDriftWatch(gitHub: GitHub, busPath: string): (db: DatabaseSync) => DriftWatch {
  const ci = new GhCiRuns()
  return db => new WeightsDriftWatch({
    latestRuns: () => ci.successfulRunsOnMain(1),
    measure: run => driftOfRun((id, artifact) => ci.downloadArtifact(id, artifact), gitHub, run),
    ledger: new BusWeightsRecompute({ db, gitHub, hand: (cardId, file, text) => handFile(launchDirOf(homedir(), busPath), cardId, file, text), clock: () => new Date() }),
  })
}
