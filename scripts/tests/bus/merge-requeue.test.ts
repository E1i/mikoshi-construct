import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_ALARM } from '../../core/events.js'
import { prBodySha } from '../../core/identifiers.js'
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
