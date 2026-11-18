import type * as ChildProcesses from 'node:child_process'
import type { ReviewPlan } from '../../nodes/review/review-depth.js'
import type { ReviewPlannerLater } from '../../nodes/review/review-executor.js'
import type { Reviewer } from '../../nodes/review/reviewer.js'
import type { MergeBench } from './merge-bench.js'
import { once } from 'node:events'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, WINDOW_LANE } from '../../core/card-bodies.js'
import { POLICY_DENIED, REVIEW_RECORDED, TASK_FAILED, TASK_LEASED } from '../../core/events.js'
import { PLAN_STEP, PRE_SESSION_LIMIT, preSessionLimitDetail } from '../../nodes/review/review-executor.js'
import { childReviewPlanner, planInThisProcess, ReviewWorker } from '../../nodes/review/review-worker.js'
import { plannerProcess } from '../../ports/review-planner.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const substitute = vi.hoisted(() => ({ script: null as string | null, children: [] as ChildProcesses.ChildProcess[] }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcesses>()
  const spawn = (file: string, args: readonly string[], options: ChildProcesses.SpawnOptions): ChildProcesses.ChildProcess => {
    const child = actual.spawn(file, substitute.script === null ? args : ['-e', substitute.script], options)
    substitute.children.push(child)
    return child
  }
  return { ...actual, spawn }
})

const PRS = [1732, 1733] as const
const LIMIT_MS = 400
const CHILD_LIMIT_MS = 2_000
const IGNORES_SIGTERM_AND_NEVER_ENDS = 'process.on(\'SIGTERM\', () => {}); process.stdin.resume(); setInterval(() => {}, 1000)'
const MIB_PAST_THE_PLAN_OUTPUT_LIMIT = 65
const cleanups: (() => void)[] = []

function writesPastTheLimitThenNeverEnds(stream: 'stdout' | 'stderr'): string {
  return `const chunk = Buffer.alloc(1 << 20, 97); let left = ${MIB_PAST_THE_PLAN_OUTPUT_LIMIT}; const out = process.${stream}; (function write() { while (left > 0) { left -= 1; if (!out.write(chunk)) { out.once('drain', write); return } } })(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0))
    cleanup()
  substitute.script = null
  for (const child of substitute.children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
})

async function signalThatEnded(child: ChildProcesses.ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode === null && child.signalCode === null)
    await once(child, 'exit')
  return child.signalCode
}

function cardOf(pr: number): number {
  return pr + 100
}

function admit(bench: MergeBench, pr: number): void {
  const card = cardOf(pr)
  const text = parkingFileText({
    card: `#${card} large-diff [implement/construct/L/cheap/auto] · depends — · blocks —`,
    branch: `feat/card-${card}`,
    touches: ['scripts/a.ts'],
    continue: 'stop',
    who: 'shift',
    body: 'Make it right.',
  })
  const parsed = parseParkingFile(`${card}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: card, file: `${card}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE))
  bench.tick()
  bench.gitHub.open({ number: pr, head: sha(String(pr % 10)), ref: `feat/card-${card}`, body: cardBody(pr) })
  bench.tick()
}

const PLANNED_ELSEWHERE: ReviewPlan = { depth: 'full', why: 'planned off the heartbeat path', prediction: null }

const readyPlanner: ReviewPlannerLater = async () => PLANNED_ELSEWHERE

function heldPlanner(): { planner: ReviewPlannerLater, release: () => void, signals: AbortSignal[] } {
  let release = (): void => {}
  const signals: AbortSignal[] = []
  const planner: ReviewPlannerLater = (_lease, _earlier, signal) => new Promise<ReviewPlan>((resolve) => {
    signals.push(signal)
    release = () => resolve(PLANNED_ELSEWHERE)
  })
  return { planner, release: () => release(), signals }
}

const passing: Reviewer = async () => ({ verdict: 'pass', findings: [], session: 'reviewer-session' })

function benchOf(prs: readonly number[]): MergeBench {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bench = liveBench()
  cleanups.push(() => bench.close())
  for (const pr of prs)
    admit(bench, pr)
  return bench
}

function workerOn(bench: MergeBench, session: string, planLater: ReviewPlannerLater, said: string[], reviewer: Reviewer = passing): ReviewWorker {
  return new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer, plan: planLater, clock: bench.clock.now, session, preSessionLimitMs: LIMIT_MS * 50, say: line => said.push(line) })
}

function leasedReviews(bench: MergeBench): number {
  return (bench.db.prepare('SELECT dedupe_key FROM events WHERE type = ?').all(TASK_LEASED) as { dedupe_key: string }[]).filter(row => row.dedupe_key.startsWith(`${TASK_LEASED}:review:`)).length
}

describe('the review node prepares a lease off its heartbeat path and within a limit', () => {
  it('the review worker keeps its heartbeat while preparing a large diff', async () => {
    const bench = benchOf(PRS)
    const said: string[] = []
    const held = heldPlanner()
    let firstDone = false

    const first = (async () => {
      const step = await workerOn(bench, 'worker-1', held.planner, said).step()
      firstDone = true
      return step
    })()
    const leasedByTheFirst = leasedReviews(bench)
    const second = await workerOn(bench, 'worker-2', readyPlanner, said).step()
    const firstDoneWhenTheSecondWas = firstDone
    const leasedByBoth = leasedReviews(bench)
    const abortedWhileHeld = held.signals.map(signal => signal.aborted)
    held.release()

    expect(abortedWhileHeld).toEqual([false])
    expect(leasedByTheFirst).toBe(1)
    expect(leasedByBoth).toBe(2)
    expect(second).toMatchObject({ kind: 'recorded', verdict: 'pass', depth: 'full' })
    expect(firstDoneWhenTheSecondWas).toBe(false)
    expect(await first).toMatchObject({ kind: 'recorded', verdict: 'pass', depth: 'full' })
    expect(eventsOf(bench.db, REVIEW_RECORDED).map(payload => payload.depth_why)).toEqual([PLANNED_ELSEWHERE.why, PLANNED_ELSEWHERE.why])
    expect(said.filter(line => line.includes('pre-session work started'))).toHaveLength(2)
    expect(said.filter(line => line.includes('pre-session work ended in'))).toHaveLength(2)
  }, 30_000)

  it('a pre-session step past its limit ends in a recorded denial', async () => {
    const bench = benchOf([PRS[0]])
    const said: string[] = []
    let reviewed = 0
    const held = heldPlanner()
    const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async () => {
      reviewed += 1
      return { verdict: 'pass', findings: [], session: 'never' }
    }, plan: held.planner, clock: bench.clock.now, session: 'worker-1', preSessionLimitMs: LIMIT_MS, say: line => said.push(line) })
    const started = Date.now()

    const step = await worker.step()

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(reviewed).toBe(0)
    expect(held.signals.map(signal => signal.aborted)).toEqual([true])
    const lease = { pr: PRS[0], head: sha(String(PRS[0] % 10)) }
    const detail = preSessionLimitDetail({ ...lease, taskKey: '', queue: 'review', cardId: cardOf(PRS[0]), leaseGen: 0, actor: '' }, PLAN_STEP, LIMIT_MS)
    expect(step).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: PRE_SESSION_LIMIT, detail } })
    expect(detail).toContain(`step ${PLAN_STEP}`)
    expect(eventsOf(bench.db, POLICY_DENIED).map(payload => [payload.reason, payload.detail])).toEqual([[PRE_SESSION_LIMIT, detail]])
    expect(eventsOf(bench.db, TASK_FAILED).map(payload => payload.reason)).toEqual([PRE_SESSION_LIMIT])
    expect(said.at(-1)).toMatch(/pre-session work ended in \d+ ms, past its limit at the step plan/)
  }, 30_000)

  it('a busy planning child that ignores SIGTERM is killed with SIGKILL once the limit passes, not left running', async () => {
    const bench = benchOf([PRS[0]])
    const said: string[] = []
    let reviewed = 0
    substitute.script = IGNORES_SIGTERM_AND_NEVER_ENDS
    const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async () => {
      reviewed += 1
      return { verdict: 'pass', findings: [], session: 'never' }
    }, plan: childReviewPlanner(process.cwd()), clock: bench.clock.now, session: 'worker-1', preSessionLimitMs: CHILD_LIMIT_MS, say: line => said.push(line) })

    const step = await worker.step()

    expect(step).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: PRE_SESSION_LIMIT } })
    expect(reviewed).toBe(0)
    expect(substitute.children).toHaveLength(1)
    expect(await signalThatEnded(substitute.children[0]!)).toBe('SIGKILL')
  }, 30_000)

  it.each(['stdout', 'stderr'] as const)('a planning child that writes past the output limit on %s and never ends is killed with SIGKILL and fails the plan', async (stream) => {
    substitute.script = writesPastTheLimitThenNeverEnds(stream)

    const planning = plannerProcess(process.cwd(), '{}', new AbortController().signal)

    await expect(planning).rejects.toMatchObject({ name: 'AbortError', cause: { message: expect.stringMatching(/^the planning output passed \d+ bytes$/) } })
    expect(substitute.children).toHaveLength(1)
    expect(await signalThatEnded(substitute.children[0]!)).toBe('SIGKILL')
  }, 30_000)

  it('a planner that fails because the limit aborted it ends in the denial, not in a full-review fallback', async () => {
    const bench = benchOf([PRS[0]])
    const said: string[] = []
    let reviewed = 0
    const rejectsWhenAborted: ReviewPlannerLater = (_lease, _earlier, signal) => new Promise<ReviewPlan>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('the planning process was killed')))
    })
    const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async () => {
      reviewed += 1
      return { verdict: 'pass', findings: [], session: 'never' }
    }, plan: rejectsWhenAborted, clock: bench.clock.now, session: 'worker-1', preSessionLimitMs: LIMIT_MS, say: line => said.push(line) })

    const step = await worker.step()

    expect(step).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: PRE_SESSION_LIMIT } })
    expect(reviewed).toBe(0)
    expect(eventsOf(bench.db, REVIEW_RECORDED)).toEqual([])
    expect(eventsOf(bench.db, TASK_FAILED).map(payload => payload.reason)).toEqual([PRE_SESSION_LIMIT])
  }, 30_000)

  it('a planner that fails falls back to the full review, as an in-process planner error does', async () => {
    const bench = benchOf([PRS[0]])
    const said: string[] = []

    const step = await workerOn(bench, 'worker-1', async () => {
      throw new Error('the planning process exited with 3')
    }, said).step()

    expect(step).toMatchObject({ kind: 'recorded', depth: 'full' })
    expect(String(eventsOf(bench.db, REVIEW_RECORDED)[0]!.depth_why)).toMatch(/^the depth could not be planned: /)
  }, 30_000)

  it('the review worker script plans a lease in its own process under the plan flag', async () => {
    const planner = childReviewPlanner(process.cwd())
    const lease = { taskKey: 'review:1832:none', queue: 'review' as const, cardId: 1832, pr: null, head: null, leaseGen: 1, actor: 'worker:review:w' }

    expect(await planner(lease, null, new AbortController().signal)).toEqual({ depth: 'full', why: 'the lease names no head', prediction: null })
  }, 60_000)

  it('the planning process prints the plan of the lease it reads as its last line', () => {
    const lease = { taskKey: 'review:1832:1732:x', queue: 'review' as const, cardId: 1832, pr: 1732, head: sha('a'), leaseGen: 1, actor: 'worker:review:w' }
    let written = ''

    const exit = planInThisProcess((given, earlier) => ({ depth: 'full', why: `${given.pr} after ${earlier?.verdict}`, prediction: null }), JSON.stringify({ lease, earlier: { head: sha('b'), verdict: 'changes', findings: [] } }), (text) => {
      written += text
    })

    expect(exit).toBe(0)
    expect(JSON.parse(written.trim().split('\n').at(-1)!)).toEqual({ depth: 'full', why: '1732 after changes', prediction: null })
  })
})
