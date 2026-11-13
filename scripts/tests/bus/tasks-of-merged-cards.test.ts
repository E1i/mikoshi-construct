import type { QueuedTask } from '../../core/queue.js'
import type { MergeBench } from './merge-bench.js'
import { describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_CLOSED, POLICY_DENIED } from '../../core/events.js'
import { prBodySha } from '../../core/identifiers.js'
import { failTask, LEASE_MS } from '../../core/lease.js'
import { FAILURES_TO_STOP, keyOf, queueTask } from '../../core/queue.js'
import { projectionDump, reduce } from '../../core/reducer.js'
import { busProjections } from '../../supervisor/composition.js'
import { cardBody, sha } from './github-fake.js'
import { liveBench, mergeBench, taskState } from './merge-bench.js'

const PR = 980
const CARD = PR + 100
const HEAD = sha('a')
const MERGE_BASE = sha('e')
const OTHER_BASE = sha('d')
const CARD_BODY = 'abcdef123456'

const mergeTask: QueuedTask = { queue: 'merge', cardId: CARD, pr: PR, head: HEAD, prBody: prBodySha(cardBody(PR)) }
const closeTask: QueuedTask = { queue: 'close', cardId: CARD, pr: PR, head: HEAD }
const plainWitness: QueuedTask = { queue: 'witness', cardId: CARD, pr: PR, head: HEAD, cardBody: CARD_BODY }

function witnessOn(base: string): QueuedTask {
  return { ...plainWitness, base }
}

function stateOf(bench: MergeBench, task: QueuedTask): string {
  return taskState(bench.db, keyOf(task)).state
}

function openedWith(tasks: readonly QueuedTask[], bench = mergeBench()): MergeBench {
  bench.gitHub.open({ number: PR, review: 'success' })
  bench.tick()
  for (const task of tasks)
    queueTask(bench.db, bench.clock.now().toISOString(), task)
  return bench
}

function ownerMerges(bench: MergeBench): void {
  bench.gitHub.close(PR, true)
  bench.tick()
}

function deniedOnWitness(bench: MergeBench, command: 'merge' | 'close', base: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: POLICY_DENIED, actor: 'policy', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${POLICY_DENIED}:${command}:${base}`, payload: { command, kind: 'technical', reason: 'witness', detail: 'no witness.recorded', base }, legacy: false })
}

function cardClosed(bench: MergeBench): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:worker-1', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${CARD_CLOSED}:${CARD}`, payload: { verification: 'run' }, legacy: false })
}

describe('a merge task on a merged pull request', () => {
  it('a queued merge task on a pull request the owner merged is withdrawn', () => {
    const bench = openedWith([mergeTask])
    expect(stateOf(bench, mergeTask)).toBe('queued')

    ownerMerges(bench)

    expect(stateOf(bench, mergeTask)).toBe('withdrawn')
    bench.close()
  })

  it('stays withdrawn on the ticks after it and on a replay of the events', () => {
    const bench = openedWith([mergeTask])
    ownerMerges(bench)
    bench.tick()
    bench.tick()

    expect(stateOf(bench, mergeTask)).toBe('withdrawn')
    const live = projectionDump(bench.db)
    reduce(bench.db, 'pending', busProjections())
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a merge the worker is finishing keeps its task, and finishes as merge.done', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: PR, review: 'success' })
    bench.tick()
    const lease = bench.lease()!

    ownerMerges(bench)

    expect(taskState(bench.db, lease.taskKey).state).toBe('leased')
    expect(bench.merge(lease)).toMatchObject({ kind: 'merged', taskKey: lease.taskKey })
    expect(taskState(bench.db, lease.taskKey).state).toBe('completed')
    bench.close()
  })

  it('a lease that has lapsed finishes nothing, so its task is withdrawn', () => {
    const bench = openedWith([mergeTask])
    bench.lease()
    ownerMerges(bench)
    expect(stateOf(bench, mergeTask)).toBe('leased')

    bench.clock.advance(LEASE_MS + 1)
    bench.tick()

    expect(stateOf(bench, mergeTask)).toBe('withdrawn')
    bench.close()
  })

  it('a stopped merge task is withdrawn', () => {
    const bench = openedWith([mergeTask])
    for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
      failTask(bench.db, bench.clock.now().toISOString(), bench.lease()!, { reason: 'no_verification', withdraw: false })
    expect(stateOf(bench, mergeTask)).toBe('stopped')

    ownerMerges(bench)

    expect(stateOf(bench, mergeTask)).toBe('withdrawn')
    bench.close()
  })
})

describe('a witness task on a merged pull request', () => {
  const cases: { name: string, task: QueuedTask, denied?: { command: 'merge' | 'close', base: string }, after: string }[] = [
    { name: 'with no base and no close waiting is withdrawn', task: plainWitness, after: 'withdrawn' },
    { name: 'on a base nothing denied is withdrawn', task: witnessOn(MERGE_BASE), after: 'withdrawn' },
    { name: 'on a base only the merge was denied on is withdrawn: the merge is over', task: witnessOn(MERGE_BASE), denied: { command: 'merge', base: MERGE_BASE }, after: 'withdrawn' },
    { name: 'on a base other than the one the close was denied on is withdrawn', task: witnessOn(OTHER_BASE), denied: { command: 'close', base: MERGE_BASE }, after: 'withdrawn' },
    { name: 'with no base while a close was denied on a base is withdrawn', task: plainWitness, denied: { command: 'close', base: MERGE_BASE }, after: 'withdrawn' },
    { name: 'on the base the close was denied on stays: the close of the card needs its record', task: witnessOn(MERGE_BASE), denied: { command: 'close', base: MERGE_BASE }, after: 'queued' },
  ]

  it.each(cases)('$name', ({ task, denied, after }) => {
    const bench = openedWith([task])
    if (denied !== undefined)
      deniedOnWitness(bench, denied.command, denied.base)

    ownerMerges(bench)

    expect(stateOf(bench, task)).toBe(after)
    bench.close()
  })

  it('the witness a close waits on is withdrawn once the card is closed', () => {
    const task = witnessOn(MERGE_BASE)
    const bench = openedWith([task])
    deniedOnWitness(bench, 'close', MERGE_BASE)
    ownerMerges(bench)
    expect(stateOf(bench, task)).toBe('queued')

    cardClosed(bench)
    bench.tick()

    expect(stateOf(bench, task)).toBe('withdrawn')
    bench.close()
  })
})

describe('a close task on a merged pull request', () => {
  it('stays while the card is open: the close is what a merge starts, by whoever merged', () => {
    const bench = openedWith([])
    ownerMerges(bench)
    queueTask(bench.db, bench.clock.now().toISOString(), closeTask)
    bench.tick()
    bench.tick()

    expect(stateOf(bench, closeTask)).toBe('queued')
    bench.close()
  })

  it('is withdrawn once its card is closed', () => {
    const bench = openedWith([])
    ownerMerges(bench)
    queueTask(bench.db, bench.clock.now().toISOString(), closeTask)
    cardClosed(bench)

    bench.tick()

    expect(stateOf(bench, closeTask)).toBe('withdrawn')
    bench.close()
  })
})
