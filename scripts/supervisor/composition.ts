import type { DatabaseSync } from 'node:sqlite'
import type { Understood } from '../core/bus-version.js'
import type { HolderStart, Lease } from '../core/lease.js'
import type { NodeKind, NodeSupply, ProcessIdentity, WorkerIdentity } from '../core/node.js'
import type { Projections } from '../core/reducer.js'
import type { Fold, StoredEvent } from '../core/stored.js'
import type { DriftWatch } from '../nodes/merge/weights-drift.js'
import type { ThresholdSet } from '../nodes/update/update-executor.js'
import type { GitHub } from '../ports/github.js'
import type { PlanActors } from '../window/plan-folds.js'
import type { SessionMeasure } from './heartbeat.js'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import process from 'node:process'
import { driftOfRun } from '../ci/weights-law.js'
import { CARD_FOLDS, CARDS_PROJECTION } from '../core/card-automaton.js'
import { admittedCardVersion } from '../core/card-bodies.js'
import { CHAINS_PROJECTION } from '../core/chain.js'
import { CARD_PLANNED, CARD_UNPLANNED, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED, PR_OBSERVED, PR_OPENED, RATCHET_THRESHOLD_SET } from '../core/events.js'
import { OWNER } from '../core/inbox.js'
import { foreignVersion, instanceOf, provenIdentity, recordWorkerIdentity, UNHANDED } from '../core/node.js'
import { orderDeclarationsAt, overlaps } from '../core/order/overlap.js'
import { TASKS_PROJECTION } from '../core/queue.js'
import { CARD_END_FOLDS, OWNER_WAIT_FOLDS, PR_FOLDS } from '../core/reducer.js'
import { BusWeightsRecompute } from '../intake/intake.js'
import { handFile } from '../nodes/launch/launch-starter.js'
import { WeightsDriftWatch } from '../nodes/merge/weights-drift.js'
import { ROLES_PROJECTION } from '../nodes/restart/role.js'
import { DECISION_FOLDS } from '../policy/decisions/index.js'
import { RECUT_ACTOR } from '../policy/round-limit-decision.js'
import { BusRead } from '../ports/bus-read.js'
import { GhCiRuns } from '../ports/ci-reading.js'
import { CHECK_MS, TICK_MS } from '../ports/netwatch.js'
import { launchDirOf } from '../ports/tree-publish.js'
import { foldPlanEvent } from '../window/plan-folds.js'
import { releasingTakeoverOnPush } from '../window/takeover-push-release.js'
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

export function nodeSupply(): NodeSupply {
  return {
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

const PLAN_ACTORS: PlanActors = { owner: OWNER, recut: RECUT_ACTOR }

function foldPlanByItsActors(db: DatabaseSync, event: StoredEvent): void {
  foldPlanEvent(db, event, PLAN_ACTORS)
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

export function busProjections(): Projections {
  return {
    folds: [releasingTakeoverOnPush(PR_FOLDS, [PR_OBSERVED, PR_OPENED]), TASKS_PROJECTION.folds, CHAINS_PROJECTION.folds, ROLES_PROJECTION.folds, DECISION_FOLDS, CARD_FOLDS, OWNER_WAIT_FOLDS, PLAN_FOLDS, CARD_END_FOLDS],
    incremental: [ROLES_PROJECTION, TASKS_PROJECTION, CHAINS_PROJECTION, CARDS_PROJECTION],
  }
}

export function weightsDriftWatch(gitHub: GitHub, busPath: string): (db: DatabaseSync) => DriftWatch {
  const ci = new GhCiRuns()
  return db => new WeightsDriftWatch({
    latestRuns: () => ci.successfulRunsOnMain(1),
    measure: run => driftOfRun((id, artifact) => ci.downloadArtifact(id, artifact), gitHub, run),
    ledger: new BusWeightsRecompute({ db, gitHub, hand: (cardId, file, text) => handFile(launchDirOf(homedir(), busPath), cardId, file, text), clock: () => new Date() }),
  })
}
