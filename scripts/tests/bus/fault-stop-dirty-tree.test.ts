import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { DiskReader } from '../../ports/disk.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { FAILURES_TO_STOP } from '../../core/queue.js'
import { launchableCard } from '../../nodes/launch/launch-candidates.js'
import { LaunchExecutor } from '../../nodes/launch/launch-executor.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
import { mergeBench, taskState } from './merge-bench.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roomy: DiskReader = () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES })
const DIRTY = 'the card tree /trees/mc-1731 has uncommitted changes'
const benches: MergeBench[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

class FailingStarter implements CardStarter {
  start(card: QueuedCard): CardStart {
    return { kind: 'refused', denial: { kind: 'technical', reason: 'start_failed', detail: `the session of card #${card.cardId} fell` } }
  }

  stop(): void {}
}

const launchKey = (cardId: number): string => taskKey({ queue: 'launch', cardId, generation: `admission-${cardId}` })

function faultStopped(cardId: number): MergeBench {
  const bench = mergeBench()
  benches.push(bench)
  const ts = (): string => bench.clock.now().toISOString()
  const executor = new LaunchExecutor({ silentMs: SILENT_MS, db: bench.db, starter: new FailingStarter(), clock: bench.clock.now, disk: roomy, isolation: sandboxed })
  appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: `lane-card-${cardId}`, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  bench.tick()
  for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1)
    executor.launch(leaseNext(bench.db, ts(), 'launch', 'worker:launch:worker-1')!)
  bench.tick()
  return bench
}

function requeued(bench: MergeBench, cardId: number, cause: string | null, keepTree: boolean): { kind: string, detail: string }[] {
  const refuse = (): never => {
    throw new Error('a requeue of a launch writes no tree')
  }
  requestFromWindow(bench.db, bench.clock.now().toISOString(), 'test', { kind: 'requeue', task_key: launchKey(cardId), ...(keepTree ? { keep_tree: true } : {}) })
  const outcomes = new WindowRequests(bench.db, bench.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: () => cause, closePr: refuse, closeDropped: () => [] }).run()
  bench.tick()
  return outcomes
}

describe('the way back of a card stopped by fault', () => {
  it('a fault stopped card with a dirty tree is relaunched by a window requeue that keeps the tree', () => {
    const bench = faultStopped(1731)

    expect(requeued(bench, 1731, DIRTY, false)).toMatchObject([{ kind: 'refused', detail: expect.stringContaining('keep_tree: true launches the session on that tree as it stands') }])
    expect(launchableCard(bench.db, 1731)).toBeNull()

    expect(requeued(bench, 1731, DIRTY, true)).toMatchObject([{ kind: 'done', detail: expect.stringContaining(`its session starts on the tree as it stands: ${DIRTY}`) }])
    expect(taskState(bench.db, launchKey(1731))).toMatchObject({ state: 'queued' })
    expect(launchableCard(bench.db, 1731)).toEqual({ lane: 'lane-card-1731', contour: 'cheap' })
  })

  it('a fault stopped card with a clean tree is relaunched by requeue as before', () => {
    const bench = faultStopped(1732)

    expect(requeued(bench, 1732, null, false)).toMatchObject([{ kind: 'done' }])
    expect(launchableCard(bench.db, 1732)).toEqual({ lane: 'lane-card-1732', contour: 'cheap' })
  })

  it('keep_tree does not pass a cause other than the dirty tree', () => {
    const bench = faultStopped(1733)

    expect(requeued(bench, 1733, 'feat/card-1733 is checked out at /elsewhere', true)).toMatchObject([{ kind: 'refused', detail: expect.stringContaining('is checked out at /elsewhere') }])
    expect(launchableCard(bench.db, 1733)).toBeNull()
  })
})
