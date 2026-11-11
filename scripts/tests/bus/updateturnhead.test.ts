import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RERUN_VARIABLE } from '../../cli/check-catalog.js'
import { appendEvent } from '../../core/db.js'
import { MERGE_DONE, REVIEW_RECORDED, TASK_LEASED, TASK_RELEASED, UPDATE_DONE } from '../../core/events.js'
import { AN_UPDATED_PR_HOLDS_MS, NEEDS_UPDATE, updateCandidates, updateTurnHeldUntil } from '../../core/queue.js'
import { MergeNode } from '../../nodes/merge/merge-worker.js'
import { cardBody, MAIN_2, REPO, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const MERGE_HEAD = 1337
const HOLDER = 1339
const HEAD_OF_THE_MERGE_HEAD = sha('e')
const HEAD_OF_THE_HOLDER = sha('f')

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

async function once(node: MergeNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function updateDone(made: MergeBench, pr: number, to: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: UPDATE_DONE, actor: 'worker:update:worker-0', cardId: pr + 100, pr, head: to, dedupeKey: `${UPDATE_DONE}:${pr}:${to}`, payload: { from: sha('b'), to, carried: 'pass', clean: true, task_key: `update-of-${pr}`, lease_gen: 1 }, legacy: false })
}

function inversion() {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1, pr: 1, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  made.gitHub.open({ number: MERGE_HEAD, head: HEAD_OF_THE_MERGE_HEAD, review: 'success', mergeable_state: 'behind', files: ['scripts/a.ts'], body: cardBody(MERGE_HEAD) })
  made.gitHub.open({ number: HOLDER, head: HEAD_OF_THE_HOLDER, review: 'success', mergeable_state: 'clean', files: ['scripts/b.ts'], body: cardBody(HOLDER) })
  made.gitHub.pulls.get(HOLDER)!.required = 'pending'
  made.tick()
  updateDone(made, HOLDER, HEAD_OF_THE_HOLDER)
  const node = new MergeNode({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode: 'live', env: { [RERUN_VARIABLE]: 'by-layers' }, rebuildCatalog: () => {} })
  const holderTurnsGreen = (): void => {
    made.gitHub.pulls.get(HOLDER)!.required = 'success'
    made.tick()
  }
  const leased = (): unknown[] => eventsOf(made.db, TASK_LEASED).map(event => event.task_key)
  const released = () => eventsOf(made.db, TASK_RELEASED).filter(event => event.reason === NEEDS_UPDATE)
  return { made, node, holderTurnsGreen, leased, released }
}

function mergedPulls(made: MergeBench): string[] {
  return made.gitHub.puts.map(put => put.endpoint)
}

describe('the merge head and the holder of the update turn', () => {
  it('a green clean holder of the update turn is leased ahead of a lower PR waiting for its update', async () => {
    const { made, node, holderTurnsGreen } = inversion()
    await once(node)
    expect(mergedPulls(made)).toEqual([])

    holderTurnsGreen()
    await once(node)

    expect(mergedPulls(made)).toEqual([`${REPO}/pulls/${HOLDER}/merge`])
  })

  it('a merge head waiting for an update does not hold the update turn away for the whole hold once the holder has merged', async () => {
    const { made, node, holderTurnsGreen } = inversion()
    await once(node)
    holderTurnsGreen()
    await once(node)
    expect(eventsOf(made.db, MERGE_DONE)).toHaveLength(1)
    made.gitHub.close(HOLDER, true)
    made.gitHub.main = MAIN_2
    made.tick()

    expect(updateCandidates(made.db, made.clock.now().toISOString(), 'by-layers').map(task => task.pr)).toEqual([MERGE_HEAD])
  })

  it('a merge head waiting for an update is not leased again while another PR holds the turn', async () => {
    const { node, leased, released } = inversion()
    await once(node)
    await once(node)
    await once(node)

    expect(leased()).toHaveLength(1)
    expect(released()).toEqual([expect.objectContaining({ until: expect.any(String) })])
  })

  it('a merge head is leased again when the hold runs out, and the turn is then its own', async () => {
    const { made, node, leased } = inversion()
    await once(node)
    made.clock.advance(AN_UPDATED_PR_HOLDS_MS + 1)
    expect(updateCandidates(made.db, made.clock.now().toISOString(), 'by-layers').map(task => task.pr)).toContain(MERGE_HEAD)

    await once(node)

    expect(leased()).toHaveLength(2)
  })

  it('a holder sent to its own update waits instead of holding the merge head, and its update is not held back', async () => {
    const { made, node, released } = inversion()
    updateDone(made, MERGE_HEAD, HEAD_OF_THE_MERGE_HEAD)
    await once(node)

    expect(released()).toEqual([expect.objectContaining({ until: expect.any(String) })])
    made.clock.advance(AN_UPDATED_PR_HOLDS_MS + 1)
    expect(updateCandidates(made.db, made.clock.now().toISOString(), 'by-layers').map(task => task.pr)).toContain(MERGE_HEAD)
  })

  it('a merge head with no holder of the turn waits instead of being leased again at once, and its update is a candidate', async () => {
    const { made, node, released } = inversion()
    made.clock.advance(AN_UPDATED_PR_HOLDS_MS + 1)
    await once(node)

    expect(released()).toEqual([expect.objectContaining({ until: expect.any(String) })])
    expect(updateCandidates(made.db, made.clock.now().toISOString(), 'by-layers').map(task => task.pr)).toContain(MERGE_HEAD)
  })

  it('the turn is held until the hold of its latest update runs out', () => {
    const { made } = inversion()
    const heldFrom = (): string | null => updateTurnHeldUntil(made.db, made.clock.now().toISOString(), MERGE_HEAD)
    const updatedAt = made.clock.now().getTime()

    expect(heldFrom()).toBe(new Date(updatedAt + AN_UPDATED_PR_HOLDS_MS).toISOString())
    expect(updateTurnHeldUntil(made.db, made.clock.now().toISOString(), HOLDER)).toBeNull()
    made.clock.advance(AN_UPDATED_PR_HOLDS_MS)
    expect(heldFrom()).toBeNull()
  })
})
