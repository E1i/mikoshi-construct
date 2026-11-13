import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leaseNext } from '../../core/lease.js'
import { deriveQueues } from '../../core/queue.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from './github-fake.js'
import { liveBench } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const CARD = 952
const PR = 952
const BEHIND_HEAD = sha('e')
const UPDATED_HEAD = sha('d')

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

function updatedPullRequest(): MergeBench {
  const bench = liveBench()
  benches.push(bench)
  const executor = new UpdateExecutor({ silentMs: SILENT_MS, db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {} })
  bench.gitHub.open({ number: PR, head: BEHIND_HEAD, review: 'success', mergeable_state: 'behind', files: ['scripts/a.ts'], body: cardBody(CARD) })
  bench.tick()
  detectUpdate(bench)
  bench.gitHub.updatedHead = UPDATED_HEAD
  executor.update(leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!)
  return bench
}

describe('the merge after an update', () => {
  it('a pull request the update node brought up to date is queued for merge without a window step', () => {
    const bench = updatedPullRequest()
    const pull = bench.gitHub.pulls.get(PR)!
    pull.required = 'success'
    bench.tick()
    deriveQueues(bench.db, bench.clock.now().toISOString())

    expect(pull.head).toBe(UPDATED_HEAD)
    expect(bench.db.prepare(`SELECT state FROM tasks WHERE queue = 'merge' AND pr = ? AND head = ?`).all(PR, UPDATED_HEAD)).toEqual([{ state: 'queued' }])
  })
})
