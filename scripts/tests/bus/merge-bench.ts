import type { DatabaseSync } from 'node:sqlite'
import type { MergeOutcome } from '../../bus/executor.js'
import type { Lease } from '../../bus/lease.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendEvent, openBus } from '../../bus/db.js'
import { MergeExecutor, SHARD_USED } from '../../bus/executor.js'
import { leaseNext } from '../../bus/lease.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { BusTick } from '../../bus/run.js'
import { Clock, FakeGitHub } from './github-fake.js'

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

export function mergeBench(intake: (db: DatabaseSync, clock: Clock) => () => void = () => () => {}): MergeBench {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-merge-'))
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now, intake(db, clock))
  const executor = new MergeExecutor({ db, gitHub: gitHub.client, put: gitHub.put, clock: clock.now, run: RUN })
  const tick = (): void => {
    busTick.run()
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

export function eventsOf(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
}

export function eventCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
}

export function taskState(db: DatabaseSync, key: string): { state: string, lease_gen: number, failures: number } {
  return db.prepare('SELECT state, lease_gen, failures FROM tasks WHERE task_key = ?').get(key) as { state: string, lease_gen: number, failures: number }
}
