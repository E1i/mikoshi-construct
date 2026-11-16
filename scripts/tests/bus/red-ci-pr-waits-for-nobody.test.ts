import type { FakePull } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { answerCandidates, mergeCandidates, unmergedDependenciesOf, updateCandidates } from '../../core/queue.js'
import { sha } from './github-fake.js'
import { liveBench } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const DEPENDENCY_PR = 1962
const DEPENDENCY = DEPENDENCY_PR + 100
const PR = 1673
const CARD = PR + 100
const HEAD = sha('a')

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  vi.restoreAllMocks()
})

function now(bench: MergeBench): string {
  return bench.clock.now().toISOString()
}

function aDependentPrOnAnOpenDependency(pull: Partial<FakePull>): MergeBench {
  const bench = liveBench()
  benches.push(bench)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  bench.gitHub.open({ number: DEPENDENCY_PR, head: sha('b') })
  bench.gitHub.open({ number: PR, head: HEAD, ...pull })
  appendEvent(bench.db, { ts: now(bench), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:admission-1`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [DEPENDENCY], admission: 'admission-1' }, legacy: false })
  bench.tick()
  bench.tick()
  detectUpdate(bench)
  return bench
}

function tasksOfTheDependent(bench: MergeBench, candidates: typeof answerCandidates): { pr: number | null | undefined, head: string | undefined }[] {
  return candidates(bench.db, now(bench)).filter(task => task.cardId === CARD).map(task => ({ pr: task.pr, head: task.head }))
}

describe('an unmerged dependency holds the merge and the update, never the answer to the PR\'s own red CI', () => {
  it('a red-CI PR whose dependency is not merged gets an answer task on its head', () => {
    const bench = aDependentPrOnAnOpenDependency({ mergeable_state: 'blocked', required: 'failure' })

    expect(unmergedDependenciesOf(bench.db, CARD)).toEqual([DEPENDENCY])
    expect(tasksOfTheDependent(bench, answerCandidates)).toEqual([{ pr: PR, head: HEAD }])
    expect(tasksOfTheDependent(bench, mergeCandidates)).toEqual([])
    expect(tasksOfTheDependent(bench, updateCandidates)).toEqual([])
  })

  it('a green-CI PR whose dependency is not merged still gets no answer task', () => {
    const bench = aDependentPrOnAnOpenDependency({ mergeable_state: 'clean', review: 'success', required: 'success' })

    expect(unmergedDependenciesOf(bench.db, CARD)).toEqual([DEPENDENCY])
    expect(tasksOfTheDependent(bench, answerCandidates)).toEqual([])
    expect(tasksOfTheDependent(bench, mergeCandidates)).toEqual([])
    expect(tasksOfTheDependent(bench, updateCandidates)).toEqual([])
  })
})
