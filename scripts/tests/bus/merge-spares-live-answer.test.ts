import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CARD_STOPPED, POLICY_DENIED } from '../../core/events.js'
import { prBodySha } from '../../core/identifiers.js'
import { keyOf } from '../../core/queue.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench, taskState } from './merge-bench.js'

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
})

function leasedOnAPass(pr: number): MergeBench {
  const made = liveBench()
  benches.push(made)
  made.gitHub.open({ number: pr, review: 'success' })
  made.tick()
  return made
}

describe('a merge task on a head its answer is fixing', () => {
  it('a head whose verdict turned changes withdraws its merge task with no failure', () => {
    const made = leasedOnAPass(960)
    const lease = made.lease()!
    made.gitHub.statuses.set(sha('a'), 'failure')

    expect(made.merge(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'no_pass_on_head', parkedUntil: 'new_head' }, next: 'withdrawn' })
    const key = keyOf({ queue: 'merge', cardId: 1060, pr: 960, head: sha('a'), prBody: prBodySha(cardBody(960)) })
    expect(taskState(made.db, key).state).toBe('withdrawn')
    expect(eventsOf(made.db, POLICY_DENIED).map(each => each.refused)).toEqual([undefined])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(made.gitHub.puts).toEqual([])
  })

  it('a head with no verdict yet still counts as a failure that queues the task again', () => {
    const made = leasedOnAPass(961)
    const lease = made.lease()!
    made.gitHub.pulls.set(961, { ...made.gitHub.pulls.get(961)!, review: undefined })

    expect(made.merge(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'no_pass_on_head' }, next: 'queued' })
  })
})
