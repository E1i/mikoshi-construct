import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_ALARM } from '../../core/events.js'
import { prBodySha } from '../../core/identifiers.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { cardBody } from './github-fake.js'
import { eventsOf, liveBench, taskState } from './merge-bench.js'

const PR = 977
const UNREADABLE_BODY = cardBody(PR, 'none')
const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
})

function withdrawnOnTheBody(): MergeBench & { withdrawnKey: string } {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, review: 'success', body: UNREADABLE_BODY })
  bench.tick()
  const lease = bench.lease()!
  expect(bench.merge(lease)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'decision_unread' } })
  return { ...bench, withdrawnKey: lease.taskKey }
}

function mergeTasks(bench: MergeBench): { task_key: string, state: string }[] {
  return bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'merge' AND pr = ? ORDER BY id`).all(PR) as { task_key: string, state: string }[]
}

describe('a merge task withdrawn on the pull request body', () => {
  it('carries the sha of the body in its key', () => {
    const bench = withdrawnOnTheBody()

    expect(bench.withdrawnKey.endsWith(`:pr-body-${prBodySha(UNREADABLE_BODY)}`)).toBe(true)
    expect(taskState(bench.db, bench.withdrawnKey).state).toBe('withdrawn')
  })

  it('is named by a board.alarm that carries the task key', () => {
    const bench = withdrawnOnTheBody()

    expect(eventsOf(bench.db, BOARD_ALARM)).toMatchObject([{ task_key: bench.withdrawnKey, reason: 'decision_unread' }])
  })

  it('is queued again under a new key after the body is edited', () => {
    const bench = withdrawnOnTheBody()
    bench.gitHub.pulls.get(PR)!.body = cardBody(PR)
    bench.tick()

    const tasks = mergeTasks(bench)
    const queued = tasks.filter(task => task.state === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.task_key).not.toBe(bench.withdrawnKey)
    expect(queued[0]!.task_key.endsWith(`:pr-body-${prBodySha(cardBody(PR))}`)).toBe(true)
    expect(taskState(bench.db, bench.withdrawnKey).state).toBe('withdrawn')
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged' })
  })

  it('stays withdrawn while the body is unchanged', () => {
    const bench = withdrawnOnTheBody()
    bench.tick()

    expect(mergeTasks(bench)).toEqual([{ task_key: bench.withdrawnKey, state: 'withdrawn' }])
  })
})

describe('a merge task of a pull request whose body was edited', () => {
  function queuedBench(): MergeBench {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: PR, review: 'success', body: cardBody(PR) })
    bench.tick()
    return bench
  }

  function editBody(bench: MergeBench): void {
    bench.gitHub.pulls.get(PR)!.body = `${cardBody(PR)}\nedited`
    bench.tick()
  }

  it('supersedes the queued task and queues one under the new body', () => {
    const bench = queuedBench()
    const [old] = mergeTasks(bench)
    editBody(bench)

    expect(taskState(bench.db, old!.task_key).state).toBe('superseded')
    const queued = mergeTasks(bench).filter(task => task.state === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.task_key.endsWith(`:pr-body-${prBodySha(`${cardBody(PR)}\nedited`)}`)).toBe(true)
  })

  it('supersedes the leased task', () => {
    const bench = queuedBench()
    const lease = bench.lease()!
    editBody(bench)

    expect(taskState(bench.db, lease.taskKey).state).toBe('superseded')
  })

  it('supersedes a task whose key has no body suffix and keeps the one under the current body', () => {
    const bench = queuedBench()
    const [current] = mergeTasks(bench)
    const { card_id: cardId, head } = bench.db.prepare('SELECT card_id, head FROM tasks WHERE task_key = ?').get(current!.task_key) as { card_id: number, head: string }
    const legacy = { queue: 'merge' as const, cardId, pr: PR, head }
    expect(queueTask(bench.db, bench.clock.now().toISOString(), legacy)).toBe(true)
    bench.tick()

    expect(taskState(bench.db, keyOf(legacy)).state).toBe('superseded')
    expect(taskState(bench.db, current!.task_key).state).toBe('queued')
  })

  it('keys the merge task by the pull request body alone, never by a review input', () => {
    const bench = queuedBench()
    const [queued] = mergeTasks(bench)
    const { card_id: cardId, head } = bench.db.prepare('SELECT card_id, head FROM tasks WHERE task_key = ?').get(queued!.task_key) as { card_id: number, head: string }

    expect(queued!.task_key).toBe(`merge:${cardId}:${PR}:${head}:pr-body-${prBodySha(cardBody(PR))}`)
    expect(queued!.task_key).not.toContain(':card-body-')
  })

  it('keys the review task by the pull request body and the card body', () => {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: PR, body: cardBody(PR) })
    bench.tick()
    const [review] = bench.db.prepare('SELECT task_key FROM tasks WHERE queue = \'review\' AND pr = ?').all(PR) as { task_key: string }[]

    expect(review!.task_key).toMatch(new RegExp(`:pr-body-${prBodySha(cardBody(PR))}:card-body--$`))
  })

  it('leaves a task alone while its body is the pull request body', () => {
    const bench = queuedBench()
    const before = mergeTasks(bench)
    bench.tick()

    expect(mergeTasks(bench)).toEqual(before)
    expect(before[0]!.state).toBe('queued')
  })
})

describe('an authority denial of a merge task', () => {
  function deniedBench(body: string, files: string[]): { bench: MergeBench, key: string, result: unknown } {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: PR, review: 'success', body, files })
    bench.tick()
    const lease = bench.lease()!
    return { bench, key: lease.taskKey, result: bench.merge(lease) }
  }

  it('no_matrix_count_line is named by a board.alarm that carries the task key', () => {
    const { bench, key, result } = deniedBench(cardBody(PR), ['src/cli.ts'])

    expect(result).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'no_matrix_count_line' } })
    expect(eventsOf(bench.db, BOARD_ALARM)).toMatchObject([{ task_key: key, reason: 'no_matrix_count_line' }])
  })

  it('a rule outside the withdrawn-on-the-body set raises no board.alarm', () => {
    const { bench, result } = deniedBench(cardBody(PR, 'owner'), [])

    expect(result).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_without_shard' } })
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })
})
