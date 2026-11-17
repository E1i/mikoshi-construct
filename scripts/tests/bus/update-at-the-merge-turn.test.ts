import { describe, expect, it } from 'vitest'
import { updateCandidates } from '../../nodes/update/update-candidates.js'
import { candidateRules } from '../../supervisor/composition.js'
import { sha } from './github-fake.js'
import { liveBench, mainMovesPastEveryPr } from './merge-bench.js'

function updatesOf(bench: ReturnType<typeof liveBench>): (number | undefined)[] {
  return updateCandidates(bench.db, bench.clock.now().toISOString(), candidateRules()).map(task => task.pr)
}

describe('an update goes to the turn of a group that needs one, never to behind alone', () => {
  it('two green behind PRs that nothing on main overlaps get no update task', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 970, head: sha('e'), review: 'success', mergeable_state: 'behind', files: ['scripts/a.ts'] })
    bench.gitHub.open({ number: 971, head: sha('f'), review: 'success', mergeable_state: 'behind', files: ['scripts/b.ts'] })
    bench.tick()
    expect(updatesOf(bench)).toEqual([])
    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'update'`).all()).toEqual([])
    bench.close()
  })

  it('of two PRs of one group that both need an update only the turn gets an update task; the other gets one once the first merges', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 972, head: sha('e'), review: 'success', files: ['scripts/a.ts'] })
    bench.gitHub.open({ number: 973, head: sha('f'), review: 'success', files: ['scripts/a.ts'] })
    bench.tick()
    mainMovesPastEveryPr(bench)
    expect(updatesOf(bench)).toEqual([972])

    bench.gitHub.close(972, true)
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
