import type { FakePull } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKFILL_SOURCE } from '../../core/backfill-source.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { completeTask, failTask, leaseNext, leaseQueued } from '../../core/lease.js'
import { answerCandidates, dependencyUpdateDueOn, FAILURES_TO_STOP, queueTask, STOPPED, unmergedDependenciesOf, updateCandidates, WITHDRAWN } from '../../core/queue.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { MAIN_2, sha } from './github-fake.js'
import { liveBench, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const DEPENDENCY_PR = 1756
const DEPENDENCY = DEPENDENCY_PR + 100
const OTHER_DEPENDENCY = 1999
const PR = 1578
const CARD = PR + 100
const OLD_HEAD = sha('a')
const OTHER_HEAD = sha('c')
const UPDATE_ACTOR = 'worker:update:worker-1'

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  vi.restoreAllMocks()
})

function newBench(): MergeBench {
  const bench = liveBench()
  benches.push(bench)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return bench
}

function now(bench: MergeBench): string {
  return bench.clock.now().toISOString()
}

function admitted(bench: MergeBench, depends: number[], admission: string, source: Record<string, string> = {}): void {
  appendEvent(bench.db, { ts: now(bench), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${admission}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends, admission, ...source }, legacy: false })
}

function settle(bench: MergeBench): void {
  bench.tick()
  bench.tick()
}

function openDependent(depends: number[], pull: Partial<FakePull> = {}): MergeBench {
  const bench = newBench()
  bench.gitHub.open({ number: DEPENDENCY_PR, head: sha('b') })
  bench.gitHub.open({ number: PR, head: OLD_HEAD, mergeable_state: 'blocked', ...pull })
  admitted(bench, depends, 'admission-1')
  settle(bench)
  return bench
}

function closeTheDependency(bench: MergeBench, merged: boolean): void {
  bench.gitHub.close(DEPENDENCY_PR, merged)
  if (merged)
    bench.gitHub.main = MAIN_2
  settle(bench)
}

function updatesOfThePr(bench: MergeBench): (string | undefined)[] {
  return updateCandidates(bench.db, now(bench)).filter(task => task.pr === PR).map(task => task.head)
}

function answersOfTheCard(bench: MergeBench): (string | undefined)[] {
  return answerCandidates(bench.db, now(bench)).filter(task => task.cardId === CARD).map(task => task.head)
}

function updateExecutor(bench: MergeBench): UpdateExecutor {
  return new UpdateExecutor({ silentMs: SILENT_MS, db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {} })
}

function updateKey(head: string): string {
  return taskKey({ queue: 'update', cardId: CARD, pr: PR, head })
}

function leasedUpdate(bench: MergeBench, head: string): ReturnType<typeof leaseNext> {
  queueTask(bench.db, now(bench), { queue: 'update', cardId: CARD, pr: PR, head })
  return leaseQueued(bench.db, now(bench), updateKey(head), UPDATE_ACTOR)
}

function failedUntil(bench: MergeBench, head: string, state: typeof WITHDRAWN | typeof STOPPED): void {
  const withdraw = state === WITHDRAWN
  const failures = withdraw ? 1 : FAILURES_TO_STOP
  queueTask(bench.db, now(bench), { queue: 'update', cardId: CARD, pr: PR, head })
  for (let failure = 0; failure < failures; failure++)
    failTask(bench.db, now(bench), leaseQueued(bench.db, now(bench), updateKey(head), UPDATE_ACTOR)!, { reason: 'github_error', withdraw }, SILENT_MS)
  expect(taskState(bench.db, updateKey(head))).toMatchObject({ state })
}

function outcomeOf(result: ReturnType<UpdateExecutor['update']>): string {
  return result.kind === 'denied' ? `denied ${(result as { denial: { reason: string } }).denial.reason}` : result.kind
}

describe('the settled update that stands in for a dependency-due update', () => {
  it('an update settled on another head of the PR after the dependency merge leaves this head due', () => {
    const bench = openDependent([DEPENDENCY])
    closeTheDependency(bench, true)
    completeTask(bench.db, now(bench), leasedUpdate(bench, OTHER_HEAD)!, [])

    expect(dependencyUpdateDueOn(bench.db, { card: CARD, pr: PR, head: OLD_HEAD })).toBe(true)
    detectUpdate(bench)
    expect(updatesOfThePr(bench)).toEqual([OLD_HEAD])
  })

  it.each([WITHDRAWN, STOPPED] as const)('an update %s on the head after the dependency merge settles the due update', (state) => {
    const bench = openDependent([DEPENDENCY])
    closeTheDependency(bench, true)
    expect(dependencyUpdateDueOn(bench.db, { card: CARD, pr: PR, head: OLD_HEAD })).toBe(true)

    failedUntil(bench, OLD_HEAD, state)

    expect(dependencyUpdateDueOn(bench.db, { card: CARD, pr: PR, head: OLD_HEAD })).toBe(false)
  })
})

describe('the admission whose depends stand', () => {
  it('a later backfill admission keeps the depends of the latest real admission', () => {
    const bench = openDependent([DEPENDENCY], { required: 'failure' })
    admitted(bench, [], 'admission-backfill', { source: BACKFILL_SOURCE })
    settle(bench)

    expect(unmergedDependenciesOf(bench.db, CARD)).toEqual([DEPENDENCY])
    expect(answersOfTheCard(bench)).toEqual([])
  })
})

describe('the update executor on a head no dependency merge made due', () => {
  it('a blocked PR of a card with no dependency is refused not_behind', () => {
    const bench = openDependent([])

    expect(dependencyUpdateDueOn(bench.db, { card: CARD, pr: PR, head: OLD_HEAD })).toBe(false)
    expect(outcomeOf(updateExecutor(bench).update(leasedUpdate(bench, OLD_HEAD)!))).toBe('denied not_behind')
    expect(bench.gitHub.pulls.get(PR)!.head).toBe(OLD_HEAD)
  })

  it('a blocked dependent whose dependency merged before its head was seen is refused not_behind', () => {
    const bench = newBench()
    bench.gitHub.open({ number: DEPENDENCY_PR, head: sha('b') })
    settle(bench)
    closeTheDependency(bench, true)
    bench.gitHub.open({ number: PR, head: OLD_HEAD, mergeable_state: 'blocked' })
    admitted(bench, [DEPENDENCY], 'admission-1')
    settle(bench)

    expect(unmergedDependenciesOf(bench.db, CARD)).toEqual([])
    expect(dependencyUpdateDueOn(bench.db, { card: CARD, pr: PR, head: OLD_HEAD })).toBe(false)
    expect(outcomeOf(updateExecutor(bench).update(leasedUpdate(bench, OLD_HEAD)!))).toBe('denied not_behind')
    expect(bench.gitHub.pulls.get(PR)!.head).toBe(OLD_HEAD)
  })
})

type PrState = 'behind' | 'blocked' | 'clean' | 'unstable' | 'dirty' | 'conflict'
type DependencyState = 'merged' | 'open' | 'closed unmerged' | 'two dependencies'

const PR_STATES: Record<PrState, { pull: Partial<FakePull>, answerInFlight: boolean }> = {
  behind: { pull: { mergeable_state: 'behind', review: 'success', required: 'success' }, answerInFlight: false },
  blocked: { pull: { mergeable_state: 'blocked' }, answerInFlight: false },
  clean: { pull: { mergeable_state: 'clean', review: 'success', required: 'success' }, answerInFlight: false },
  unstable: { pull: { mergeable_state: 'unstable', review: 'success', required: 'success' }, answerInFlight: false },
  dirty: { pull: { mergeable_state: 'dirty' }, answerInFlight: false },
  conflict: { pull: { mergeable_state: 'dirty' }, answerInFlight: true },
}

const DEPENDENCY_STATES: Record<DependencyState, { depends: number[], merged: boolean | null }> = {
  'merged': { depends: [DEPENDENCY], merged: true },
  'open': { depends: [DEPENDENCY], merged: null },
  'closed unmerged': { depends: [DEPENDENCY], merged: false },
  'two dependencies': { depends: [DEPENDENCY, OTHER_DEPENDENCY], merged: true },
}

const UPDATED = 'updated'
const REFUSED_NOT_BEHIND = 'denied not_behind'
const NO_UPDATE = null

const WHAT_THE_BUS_DOES: Record<PrState, Record<DependencyState, typeof UPDATED | typeof REFUSED_NOT_BEHIND | typeof NO_UPDATE>> = {
  behind: { 'merged': UPDATED, 'open': UPDATED, 'closed unmerged': UPDATED, 'two dependencies': UPDATED },
  blocked: { 'merged': UPDATED, 'open': NO_UPDATE, 'closed unmerged': NO_UPDATE, 'two dependencies': NO_UPDATE },
  clean: { 'merged': UPDATED, 'open': NO_UPDATE, 'closed unmerged': NO_UPDATE, 'two dependencies': NO_UPDATE },
  unstable: { 'merged': UPDATED, 'open': NO_UPDATE, 'closed unmerged': NO_UPDATE, 'two dependencies': NO_UPDATE },
  dirty: { 'merged': REFUSED_NOT_BEHIND, 'open': REFUSED_NOT_BEHIND, 'closed unmerged': REFUSED_NOT_BEHIND, 'two dependencies': REFUSED_NOT_BEHIND },
  conflict: { 'merged': NO_UPDATE, 'open': NO_UPDATE, 'closed unmerged': NO_UPDATE, 'two dependencies': NO_UPDATE },
}

const CELLS = (Object.keys(WHAT_THE_BUS_DOES) as PrState[]).flatMap(prState =>
  (Object.keys(WHAT_THE_BUS_DOES[prState]) as DependencyState[]).map(dependencyState => ({ prState, dependencyState, expected: WHAT_THE_BUS_DOES[prState][dependencyState] })),
)

describe('a dependent PR state × its dependency state', () => {
  it.each(CELLS)('$prState × $dependencyState → $expected', ({ prState, dependencyState, expected }) => {
    const pr = PR_STATES[prState]
    const dependency = DEPENDENCY_STATES[dependencyState]
    const bench = openDependent(dependency.depends, pr.pull)
    if (pr.answerInFlight)
      queueTask(bench.db, now(bench), { queue: 'answer', cardId: CARD, pr: PR, head: OLD_HEAD })
    if (dependency.merged !== null)
      closeTheDependency(bench, dependency.merged)
    detectUpdate(bench)

    expect(updatesOfThePr(bench)).toEqual(expected === NO_UPDATE ? [] : [OLD_HEAD])
    expect(answersOfTheCard(bench)).toEqual([])
    const lease = leaseNext(bench.db, now(bench), 'update', UPDATE_ACTOR)
    expect(lease === null ? NO_UPDATE : outcomeOf(updateExecutor(bench).update(lease))).toBe(expected)
  })
})
