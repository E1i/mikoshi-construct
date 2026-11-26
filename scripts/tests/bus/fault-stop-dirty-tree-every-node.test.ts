import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { FAILURES_TO_STOP } from '../../core/queue.js'
import { launchableCard } from '../../nodes/launch/launch-candidates.js'
import { LaunchExecutor } from '../../nodes/launch/launch-executor.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { CONTINUED_FROM_THE_TREE } from '../../window/requests/requeue.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
import { mergeBench, taskState } from './merge-bench.js'

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

class FallingStarter implements CardStarter {
  start(card: QueuedCard): CardStart {
    return { kind: 'refused', denial: { kind: 'technical', reason: 'start_failed', detail: `the session of card #${card.cardId} fell` } }
  }

  stop(): void {}
}

const launchKey = (cardId: number): string => taskKey({ queue: 'launch', cardId, generation: `admission-${cardId}` })

const dirtyTreeOf = (cardId: number): string => `the card tree /trees/mc-${cardId} has uncommitted changes`

function faultStopped(cardId: number): MergeBench {
  const bench = mergeBench()
  benches.push(bench)
  const ts = (): string => bench.clock.now().toISOString()
  const executor = new LaunchExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: bench.db, starter: new FallingStarter(), clock: bench.clock.now, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
  appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: `lane-card-${cardId}`, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  bench.tick()
  for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1)
    executor.launch(leaseNext(bench.db, pullRequests(bench.db), ts(), 'launch', 'worker:launch:worker-1')!)
  bench.tick()
  return bench
}

function plainRequeue(bench: MergeBench, cardId: number, cause: string): { kind: string, detail: string }[] {
  const refuse = (): never => {
    throw new Error('the way back writes nothing in the tree')
  }
  requestFromWindow(bench.db, bench.clock.now().toISOString(), 'test', { kind: 'requeue', task_key: launchKey(cardId) })
  const outcomes = new WindowRequests(bench.db, bench.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: () => cause, closePr: refuse, closeDropped: () => [] }).run()
  bench.tick()
  return outcomes
}

describe('the dirty-tree way back is the rule of every node', () => {
  it('a fault-stopped launch card with a dirty tree is continued from that tree and its requeue is not refused', () => {
    const bench = faultStopped(2340)
    expect(taskState(bench.db, launchKey(2340))).toMatchObject({ state: 'stopped' })

    expect(plainRequeue(bench, 2340, dirtyTreeOf(2340))).toMatchObject([{ kind: 'done', detail: expect.stringContaining(`${CONTINUED_FROM_THE_TREE}: ${dirtyTreeOf(2340)}`) }])
    expect(taskState(bench.db, launchKey(2340))).toMatchObject({ state: 'queued' })
    expect(launchableCard(bench.db, 2340)).toEqual({ lane: 'lane-card-2340', contour: 'cheap' })
  })

  it('a cause other than the dirty tree still holds the requeue back', () => {
    const bench = faultStopped(2341)

    expect(plainRequeue(bench, 2341, 'feat/card-2341 is checked out at /elsewhere')).toMatchObject([{ kind: 'refused', detail: expect.stringContaining('is checked out at /elsewhere') }])
    expect(launchableCard(bench.db, 2341)).toBeNull()
  })
})
