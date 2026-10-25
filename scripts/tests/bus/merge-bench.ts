import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { MergeOutcome } from '../../nodes/merge/merge-executor.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendEvent, openBus } from '../../core/db.js'
import { leaseNext } from '../../core/lease.js'
import { MergeExecutor } from '../../nodes/merge/merge-executor.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { REVIEW_ROUNDS } from '../../core/queue.js'
import { BusTick } from '../../supervisor/run.js'
import { CARD_VERIFIED, REVIEW_RECORDED, SHARD_USED } from '../../core/events.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'
import { detectMerge } from './merge-detection.js'
import { detectReview } from './review-detection.js'

export const RUN = '/shift/run-1'

export interface MergeBench {
  db: DatabaseSync
  busPath: string
  gitHub: FakeGitHub
  clock: Clock
  tick: () => void
  lease: (actor?: string) => Lease | null
  merge: (lease: Lease) => MergeOutcome
  issueShard: () => void
  close: () => void
}

type Intake = (db: DatabaseSync, clock: Clock) => () => void

type LiveNodes = (bench: Pick<MergeBench, 'db' | 'gitHub' | 'clock'>) => void

const NO_NODES: LiveNodes = () => {}

function reviewAndMergeNodes(bench: Pick<MergeBench, 'db' | 'gitHub' | 'clock'>): void {
  detectReview(bench)
  detectMerge(bench)
}

export function liveBench(intake?: Intake): MergeBench {
  return mergeBench(intake, reviewAndMergeNodes)
}

export function mergeBench(intake: Intake = () => () => {}, liveNodes: LiveNodes = NO_NODES): MergeBench {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-merge-'))
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now, intake(db, clock))
  const executor = new MergeExecutor({ db, gitHub: gitHub.client, put: gitHub.put, publish: gitHub.publish, clock: clock.now, run: RUN })
  const tick = (): void => {
    busTick.run()
    liveNodes({ db, gitHub, clock })
    clock.advance(TICK_MS)
  }
  tick()
  return {
    db,
    busPath,
    gitHub,
    clock,
    tick,
    lease: (actor = 'worker:merge:worker-1') => leaseNext(db, clock.now().toISOString(), 'merge', actor),
    merge: lease => executor.merge(lease),
    issueShard: () => {
      appendEvent(db, { ts: clock.now().toISOString(), type: SHARD_USED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_USED}:shard-1`, payload: { id: 'shard-1', run: RUN }, legacy: false })
    },
    close: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function cardVerified(db: DatabaseSync, ts: string, cardId: number, pr: number, verification = 'run'): void {
  appendEvent(db, { ts, type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId, pr, head: null, dedupeKey: `${CARD_VERIFIED}:${cardId}:${pr}:${verification}`, payload: { path: 'cheap', pr, verification }, legacy: false })
}

export function spendReviewRounds(bench: MergeBench, pr: number, head: string): void {
  for (let round = 1; round <= REVIEW_ROUNDS; round += 1) {
    const reviewed = round === REVIEW_ROUNDS ? head : sha(String(round))
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: `worker:review:session-${round}`, cardId: pr + 100, pr, head: reviewed, dedupeKey: `${REVIEW_RECORDED}:round-${round}`, payload: { head: reviewed, verdict: 'changes', reviewer_session: `session-${round}`, findings: [] }, legacy: false })
  }
}

export function eventsOf(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
}

export function eventCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
}

export function taskState(db: DatabaseSync, key: string): { state: string, lease_gen: number, failures: number } {
  return db.prepare('SELECT state, lease_gen, failures FROM tasks WHERE task_key = ?').get(key) as { state: string, lease_gen: number, failures: number }
}
