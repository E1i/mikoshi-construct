import type { ReviewPlan } from '../../nodes/review/review-depth.js'
import type { ReviewPlannerLater } from '../../nodes/review/review-executor.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { POLICY_DENIED, REVIEW_RECORDED, TASK_FAILED } from '../../core/events.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const PR = 1770
const CARD = 2047
const LIMIT_MS = 1_000
const cleanups: (() => void)[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

function admitted(): MergeBench {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bench = liveBench()
  cleanups.push(() => bench.close())
  const text = parkingFileText({
    card: `#${CARD} lanes-retired-intake [implement/construct/L/cheap/auto] · depends — · blocks —`,
    branch: `feat/card-${CARD}`,
    touches: ['scripts/a.ts'],
    continue: 'stop',
    who: 'shift',
    body: 'Make it right.',
  })
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now()))
  bench.tick()
  bench.gitHub.open({ number: PR, head: sha('0'), ref: `feat/card-${CARD}`, body: cardBody(PR) })
  bench.tick()
  return bench
}

describe('a review planner that hits its limit degrades to the default depth', () => {
  it('records the verdict at the full depth with the limit as its reason, aborts the planner and denies nothing', async () => {
    const bench = admitted()
    const said: string[] = []
    const signals: AbortSignal[] = []
    const neverResolves: ReviewPlannerLater = (_lease, _earlier, signal) => {
      signals.push(signal)
      return new Promise<ReviewPlan>(() => {})
    }
    let reviewedAt: string | null = null
    const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async (_lease, plan) => {
      reviewedAt = plan.depth
      return { verdict: 'pass', findings: [], session: 'reviewer-session' }
    }, plan: neverResolves, clock: bench.clock.now, session: 'worker-1', preSessionLimitMs: LIMIT_MS, say: line => said.push(line) })

    const step = await worker.step()

    expect(signals.map(signal => signal.aborted)).toEqual([true])
    expect(reviewedAt).toBe('full')
    expect(step).toMatchObject({ kind: 'recorded', verdict: 'pass', depth: 'full' })
    const recorded = eventsOf(bench.db, REVIEW_RECORDED)
    expect(recorded.map(payload => [payload.verdict, payload.depth])).toEqual([['pass', 'full']])
    expect(String(recorded[0]!.depth_why)).toMatch(/planner passed its limit.*step plan.*1 s/)
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    expect(eventsOf(bench.db, TASK_FAILED)).toEqual([])
    expect(said.filter(line => /pre-session work ended in \d+ ms, past its limit at the step plan/.test(line))).toHaveLength(1)
  }, 30_000)
})
