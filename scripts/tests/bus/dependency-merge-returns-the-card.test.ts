import type { Lease } from '../../core/lease.js'
import type { FakePull } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openOwnerWaits } from '../../core/bus-readings.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, POLICY_DENIED, PR_CLOSED, QUESTION_AGENT } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { answerCandidates, queueTask, updateCandidates } from '../../core/queue.js'
import { AnswerSources } from '../../nodes/answer/duties/source.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { cardBody, MAIN_2, sha } from './github-fake.js'
import { eventsOf, liveBench, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const DEPENDENCY_PR = 1756
const DEPENDENCY = DEPENDENCY_PR + 100
const OTHER_DEPENDENCY = 1999
const ABANDONED_DEPENDENCY_PR = 1757
const PR = 1578
const CARD = PR + 100
const OLD_HEAD = sha('a')
const PUSHED_HEAD = sha('c')
const UPDATED_HEAD = sha('d')

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  vi.restoreAllMocks()
})

interface DependentCard {
  bench: MergeBench
  sources: AnswerSources
  answerLease: (head: string) => Lease
  waitsOfTheCard: () => string[]
  answersOfTheCard: () => (string | undefined)[]
}

function admitted(bench: MergeBench, depends: number[], admission: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${admission}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends, admission }, legacy: false })
}

function stoppedAfterAnEmptyRound(): DependentCard {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: DEPENDENCY_PR, head: sha('b') })
  bench.gitHub.open({ number: PR, head: OLD_HEAD, mergeable_state: 'blocked', required: 'failure' })
  const ts = bench.clock.now().toISOString()
  admitted(bench, [], 'admission-1')
  appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: `/trees/mc-${CARD}`, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(bench.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: PR, head: OLD_HEAD, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: `card #${CARD} asks a question` }, legacy: false })
  appendEvent(bench.db, { ts, type: POLICY_DENIED, actor: 'worker:answer:worker-1', cardId: CARD, pr: PR, head: OLD_HEAD, dedupeKey: `${POLICY_DENIED}:empty-round:${CARD}`, payload: { command: 'answer', kind: 'technical', reason: 'left_nothing', detail: 'an empty round' }, legacy: false })
  bench.tick()
  return dependentCard(bench)
}

function dependentCard(bench: MergeBench): DependentCard {
  return {
    bench,
    sources: new AnswerSources({ db: bench.db, clock: bench.clock.now }),
    answerLease: head => ({ taskKey: `answer:${CARD}:${head}`, queue: 'answer', cardId: CARD, pr: PR, head, leaseGen: 1, actor: 'worker:answer:worker-1' }),
    waitsOfTheCard: () => openOwnerWaits(bench.db).filter(wait => wait.card === CARD).map(wait => wait.text),
    answersOfTheCard: () => answerCandidates(bench.db, bench.clock.now().toISOString()).filter(task => task.cardId === CARD).map(task => task.head),
  }
}

function heldByAnOpenDependency(): DependentCard {
  const card = stoppedAfterAnEmptyRound()
  expect(card.sources.sourceOf(card.answerLease(OLD_HEAD))).toBeNull()
  card.bench.tick()
  expect(card.waitsOfTheCard()).toHaveLength(1)
  admitted(card.bench, [DEPENDENCY], 'admission-2')
  card.bench.tick()
  return card
}

function updatesOfThePr(bench: MergeBench): (string | undefined)[] {
  return updateCandidates(bench.db, bench.clock.now().toISOString()).filter(task => task.pr === PR).map(task => task.head)
}

function openDependent(depends: number[], pull: Partial<FakePull> = {}): DependentCard {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: DEPENDENCY_PR, head: sha('b') })
  bench.gitHub.open({ number: PR, head: OLD_HEAD, mergeable_state: 'blocked', ...pull })
  admitted(bench, depends, 'admission-1')
  bench.tick()
  bench.tick()
  return dependentCard(bench)
}

function mergeTheDependency(bench: MergeBench): void {
  bench.gitHub.close(DEPENDENCY_PR, true)
  bench.gitHub.main = MAIN_2
  bench.tick()
  bench.tick()
  detectUpdate(bench)
}

function updateExecutor(bench: MergeBench): UpdateExecutor {
  return new UpdateExecutor({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {} })
}

describe('a dependency merge returns the dependent card (owner s631)', () => {
  it('a card with an open PR and an unmerged dependency gets no answer round and no owner wait', () => {
    const card = stoppedAfterAnEmptyRound()
    admitted(card.bench, [DEPENDENCY], 'admission-2')
    card.bench.tick()

    expect(card.answersOfTheCard()).toEqual([])
    expect(card.sources.sourceOf(card.answerLease(OLD_HEAD))).toBeNull()
    expect(card.sources.dirtyOnHead(card.answerLease(OLD_HEAD))).toBe(false)
    card.bench.tick()

    expect(card.waitsOfTheCard()).toEqual([])
    expect(eventsOf(card.bench.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('the merge of the dependency updates the branch of the dependent PR and closes its wait', () => {
    const card = heldByAnOpenDependency()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(updatesOfThePr(card.bench)).toEqual([])

    card.bench.gitHub.close(DEPENDENCY_PR, true)
    card.bench.gitHub.main = MAIN_2
    card.bench.tick()
    card.bench.tick()
    detectUpdate(card.bench)

    const update = taskKey({ queue: 'update', cardId: CARD, pr: PR, head: OLD_HEAD })
    expect(taskState(card.bench.db, update)).toMatchObject({ state: 'queued' })
    expect(card.answersOfTheCard()).toEqual([])

    const executor = updateExecutor(card.bench)
    const lease = leaseNext(card.bench.db, card.bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')
    expect(lease).toMatchObject({ taskKey: update })
    expect(executor.update(lease!)).toMatchObject({ kind: 'updated', from: OLD_HEAD, to: UPDATED_HEAD })
    card.bench.tick()
    card.bench.tick()

    expect(updatesOfThePr(card.bench)).toEqual([])
    expect(card.answersOfTheCard()).toEqual([UPDATED_HEAD])
    expect(card.sources.sourceOf(card.answerLease(UPDATED_HEAD))).toMatchObject({ kind: 'question' })
    card.bench.tick()

    expect(card.waitsOfTheCard()).toEqual([])
    expect(eventsOf(card.bench.db, OWNER_WAIT_CLOSED)).toMatchObject([{ answer: `lifted: a new head ${UPDATED_HEAD} on pull request #${PR}` }])
  })

  it('an exit from the wait does not replay a stop whose dependency is open', () => {
    const card = heldByAnOpenDependency()

    card.bench.gitHub.pulls.get(PR)!.head = PUSHED_HEAD
    card.bench.tick()
    card.bench.tick()

    expect(card.answersOfTheCard()).toEqual([])
    expect(card.sources.awaitedStop(card.answerLease(PUSHED_HEAD))).not.toBeNull()
    expect(card.sources.sourceOf(card.answerLease(PUSHED_HEAD))).toBeNull()
    card.bench.tick()

    expect(card.waitsOfTheCard()).toHaveLength(1)
    expect(eventsOf(card.bench.db, OWNER_WAIT_CLOSED)).toEqual([])
    expect(eventsOf(card.bench.db, OWNER_WAIT_OPENED)).toHaveLength(1)
  })

  it.each([
    { depends: [DEPENDENCY], dirtyAnswer: false },
    { depends: [], dirtyAnswer: true },
  ])('a dirty head opens an answer only when no dependency of the card is unmerged (depends $depends)', ({ depends, dirtyAnswer }) => {
    const card = openDependent(depends, { mergeable_state: 'dirty' })

    expect(card.sources.dirtyOnHead(card.answerLease(OLD_HEAD))).toBe(dirtyAnswer)
  })

  it.each([
    { depends: [DEPENDENCY], answers: [] },
    { depends: [], answers: [OLD_HEAD] },
  ])('red CI on an open PR gets an answer round only when no dependency of the card is unmerged (depends $depends)', ({ depends, answers }) => {
    const card = openDependent(depends, { required: 'failure' })

    expect(card.answersOfTheCard()).toEqual(answers)
  })

  it('an update that leaves the head where it was is not queued again on that head', () => {
    const card = openDependent([DEPENDENCY])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mergeTheDependency(card.bench)
    expect(updatesOfThePr(card.bench)).toEqual([OLD_HEAD])

    card.bench.gitHub.updatedHead = OLD_HEAD
    updateExecutor(card.bench).update(leaseNext(card.bench.db, card.bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!)
    card.bench.tick()
    card.bench.tick()
    detectUpdate(card.bench)

    expect(updatesOfThePr(card.bench)).toEqual([])
  })

  it('the merge of one dependency leaves the branch alone while another dependency is open', () => {
    const card = openDependent([DEPENDENCY, OTHER_DEPENDENCY])
    mergeTheDependency(card.bench)

    expect(updatesOfThePr(card.bench)).toEqual([])
    expect(card.answersOfTheCard()).toEqual([])
  })

  it('a conflicting dependent with an answer in flight gets no update from the dependency merge', () => {
    const card = openDependent([DEPENDENCY], { mergeable_state: 'dirty' })
    queueTask(card.bench.db, card.bench.clock.now().toISOString(), { queue: 'answer', cardId: CARD, pr: PR, head: OLD_HEAD })
    mergeTheDependency(card.bench)

    expect(updatesOfThePr(card.bench)).toEqual([])
  })

  it('a question stop with no PR still gets its answer source while a dependency is unmerged', () => {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: DEPENDENCY_PR, head: sha('b') })
    admitted(bench, [DEPENDENCY], 'admission-1')
    const ts = bench.clock.now().toISOString()
    appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: `/trees/mc-${CARD}`, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
    appendEvent(bench.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: `card #${CARD} asks a question` }, legacy: false })
    bench.tick()
    const sources = new AnswerSources({ db: bench.db, clock: bench.clock.now })

    expect(sources.sourceOf({ taskKey: `answer:${CARD}`, queue: 'answer', cardId: CARD, pr: null, head: null, leaseGen: 1, actor: 'worker:answer:worker-1' })).toMatchObject({ kind: 'question' })
  })

  it('an update queued after the dependency merge is refused when a re-admission adds an open dependency before the lease', () => {
    const card = openDependent([DEPENDENCY])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mergeTheDependency(card.bench)
    expect(updatesOfThePr(card.bench)).toEqual([OLD_HEAD])

    admitted(card.bench, [DEPENDENCY, OTHER_DEPENDENCY], 'admission-2')
    const lease = leaseNext(card.bench.db, card.bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')

    expect(updateExecutor(card.bench).update(lease!)).toMatchObject({ kind: 'denied' })
    expect(card.bench.gitHub.pulls.get(PR)!.head).toBe(OLD_HEAD)
  })

  it('a dependency-due update on a PR that turned dirty is refused when no main merge is configured', () => {
    const card = openDependent([DEPENDENCY])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mergeTheDependency(card.bench)
    expect(updatesOfThePr(card.bench)).toEqual([OLD_HEAD])

    card.bench.gitHub.pulls.get(PR)!.mergeable_state = 'dirty'
    const lease = leaseNext(card.bench.db, card.bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')

    expect(updateExecutor(card.bench).update(lease!)).toMatchObject({ kind: 'denied' })
    expect(card.bench.gitHub.pulls.get(PR)!.head).toBe(OLD_HEAD)
  })

  it('a dependency PR closed without merging does not update its dependents', () => {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: DEPENDENCY_PR, head: sha('b') })
    bench.tick()
    bench.gitHub.close(DEPENDENCY_PR, true)
    bench.gitHub.main = MAIN_2
    bench.tick()
    bench.gitHub.open({ number: PR, head: OLD_HEAD, mergeable_state: 'blocked' })
    admitted(bench, [DEPENDENCY], 'admission-1')
    bench.tick()
    bench.gitHub.open({ number: ABANDONED_DEPENDENCY_PR, head: sha('e'), title: `feat: card #${DEPENDENCY}`, body: cardBody(DEPENDENCY_PR), ref: `feat/card-${DEPENDENCY}` })
    bench.tick()
    bench.gitHub.close(ABANDONED_DEPENDENCY_PR, false)
    bench.tick()
    bench.tick()
    detectUpdate(bench)

    expect(bench.db.prepare('SELECT card_id FROM events WHERE type = ? AND pr = ?').all(PR_CLOSED, ABANDONED_DEPENDENCY_PR)).toEqual([{ card_id: DEPENDENCY }])
    expect(updatesOfThePr(bench)).toEqual([])
  })
})
