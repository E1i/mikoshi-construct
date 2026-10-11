import type { MergeWorkerParts } from '../../bus/merge-worker.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { MERGE_DONE, SHARD_ISSUED, SHARD_USED, unspentShard } from '../../bus/executor.js'
import { ownerInbox } from '../../bus/inbox.js'
import { firstLiveVerdict, NoLiveVerdict, runMergeWorker, startMergeWorker } from '../../bus/merge-worker.js'
import { DRY_RUN_ACTOR, REVIEW_RECORDED } from '../../bus/review-worker.js'
import { runShard } from '../../shift/shard.js'
import { cardBody, sha } from './github-fake.js'
import { eventCount, eventsOf, mergeBench } from './merge-bench.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function recorded(bench: ReturnType<typeof mergeBench>, actor: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor, cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:${actor}`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
}

function parts(bench: ReturnType<typeof mergeBench>): MergeWorkerParts {
  return { db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, clock: bench.clock.now, session: 'worker-1', run: null }
}

describe('the merge worker', () => {
  it('the merge worker refuses to switch on before the first live review verdict', async () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 970, review: 'success' })
    bench.tick()
    expect(() => startMergeWorker(parts(bench))).toThrow(NoLiveVerdict)

    recorded(bench, 'owner')
    recorded(bench, DRY_RUN_ACTOR)
    expect(firstLiveVerdict(bench.db)).toBeNull()
    const before = eventCount(bench.db)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runMergeWorker(['--on'], { busPath: bench.busPath, gitHub: bench.gitHub.client, put: bench.gitHub.put, session: 'worker-1', pause: async () => {} })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('refused to switch on'))
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.gitHub.puts).toEqual([])

    recorded(bench, 'worker:review:reviewer-1')
    const worker = startMergeWorker(parts(bench))
    expect(worker.step()).toMatchObject({ kind: 'merged' })
    expect(worker.step()).toEqual({ kind: 'idle' })
    bench.close()
  })

  it('an owner pull request under an issued shard goes from pass to merge.done with rule owner_under_shard and no owner step', () => {
    const bench = mergeBench()
    recorded(bench, 'worker:review:reviewer-1')
    bench.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'owner') })
    bench.gitHub.open({ number: 727, review: 'success', body: cardBody(727, 'owner') })
    const out: string[] = []
    expect(runShard(['--card', '826', '--by', 'Eli'], { cwd: path.dirname(bench.busPath), handoffDir: path.dirname(bench.busPath), append: (file, text) => writeFileSync(file, text, { flag: 'a' }), record: event => appendEvent(bench.db, event), now: bench.clock.now, uuid: () => 'shard-826', by: () => '', out: line => out.push(line), err: line => out.push(line) })).toBe(0)
    bench.tick()

    const worker = startMergeWorker(parts(bench))
    const steps = [worker.step(), worker.step()]
    expect(steps).toMatchObject([{ kind: 'merged', rule: 'owner_under_shard' }, { kind: 'denied', denial: { kind: 'authority', rule: 'owner_without_shard' } }])
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([{ commit: expect.any(String) as unknown, rule: 'owner_under_shard' }])
    expect(eventsOf(bench.db, SHARD_USED)).toEqual([{ id: 'shard-826', commit: expect.any(String) as unknown }])
    expect(bench.gitHub.puts).toHaveLength(1)
    expect(ownerInbox(bench.db).map(line => line.pr)).toEqual([727])
    expect(bench.db.prepare(`SELECT type FROM events WHERE actor = 'owner' AND type != ? ORDER BY id`).all(REVIEW_RECORDED).map(row => row.type)).toEqual([SHARD_ISSUED])
    bench.close()
  })

  it('a spent shard covers no second owner pull request of its card', () => {
    const bench = mergeBench()
    recorded(bench, 'worker:review:reviewer-1')
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: 726, head: null, dedupeKey: `${SHARD_ISSUED}:shard-726`, payload: { id: 'shard-726', by: 'Eli', run: null }, legacy: false })
    bench.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'owner') })
    bench.tick()
    const worker = startMergeWorker(parts(bench))
    expect(worker.step()).toMatchObject({ kind: 'merged', rule: 'owner_under_shard' })
    expect(unspentShard(bench.db, 826, 726)).toBeNull()
    bench.close()
  })

  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = mergeBench()
    expect(await runMergeWorker([], { busPath: '/nonexistent/bus.db', gitHub: bench.gitHub.client, put: bench.gitHub.put, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
    bench.close()
  })
})
