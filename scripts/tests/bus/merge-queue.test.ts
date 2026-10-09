import type { MergeWorkerParts } from '../../bus/merge-worker.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { firstLiveVerdict, NoLiveVerdict, runMergeWorker, startMergeWorker } from '../../bus/merge-worker.js'
import { DRY_RUN_ACTOR, REVIEW_RECORDED } from '../../bus/review-worker.js'
import { sha } from './github-fake.js'
import { eventCount, mergeBench } from './merge-bench.js'

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

  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = mergeBench()
    expect(await runMergeWorker([], { busPath: '/nonexistent/bus.db', gitHub: bench.gitHub.client, put: bench.gitHub.put, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
    bench.close()
  })
})
