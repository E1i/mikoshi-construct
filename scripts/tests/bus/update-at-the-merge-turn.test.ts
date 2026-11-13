import { describe, expect, it } from 'vitest'
import { updateCandidates } from '../../core/queue.js'
import { MAIN_2, sha } from './github-fake.js'
import { liveBench } from './merge-bench.js'

function updatesOf(bench: ReturnType<typeof liveBench>): (number | undefined)[] {
  return updateCandidates(bench.db, bench.clock.now().toISOString()).map(task => task.pr)
}

describe('a green behind pull request is updated only at its merge turn', () => {
  it('of two green behind PRs only the one at the merge turn gets an update task; the other gets none until the first merges', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 970, head: sha('e'), review: 'success', mergeable_state: 'behind' })
    bench.gitHub.open({ number: 971, head: sha('f'), review: 'success', mergeable_state: 'behind' })
    bench.tick()
    expect(updatesOf(bench)).toEqual([970])

    bench.gitHub.pulls.get(970)!.mergeable_state = 'clean'
    bench.tick()
    expect(updatesOf(bench)).toEqual([])

    bench.gitHub.close(970, true)
    bench.gitHub.main = MAIN_2
    bench.tick()
    expect(updatesOf(bench)).toEqual([971])
    bench.close()
  })

  it('a green behind PR is not updated while a clean pass PR waits to merge ahead of it', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 972, head: sha('e'), review: 'success' })
    bench.gitHub.open({ number: 973, head: sha('f'), review: 'success', mergeable_state: 'behind' })
    bench.tick()
    expect(updatesOf(bench)).toEqual([])
    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'update'`).all()).toEqual([])

    bench.gitHub.close(972, true)
    bench.gitHub.main = MAIN_2
    bench.tick()
    expect(updatesOf(bench)).toEqual([973])
    bench.close()
  })

  it('a green behind PR is not updated while a merge task of another PR is open', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 974, head: sha('e'), review: 'success' })
    bench.gitHub.open({ number: 975, head: sha('f'), review: 'success', mergeable_state: 'behind' })
    bench.tick()
    expect(bench.lease()).toMatchObject({ queue: 'merge', pr: 974 })
    bench.gitHub.pulls.get(974)!.mergeable_state = 'unknown'
    bench.tick()
    expect(bench.db.prepare(`SELECT state FROM tasks WHERE queue = 'merge' AND pr = 974`).get()).toEqual({ state: 'leased' })
    expect(updatesOf(bench)).toEqual([])
    bench.close()
  })
})
