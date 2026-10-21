import type { Lease } from '../../bus/lease.js'
import type { DetectionMode, Scope } from '../../bus/node.js'
import type { SessionInput } from '../../bus/prompt-store.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { ReviewPlan } from '../../bus/review-depth.js'
import type { Step } from '../../bus/review-executor.js'
import type { ReviewNodeParts, ReviewRun } from '../../bus/review-worker.js'
import type { Review, Reviewer } from '../../bus/reviewer.js'
import type { IsolationReader } from '../../ghosts/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { prBodySha, taskKey } from '../../bus/identifiers.js'
import { RENEW_MS } from '../../bus/lease.js'
import { CHECK_MS, TICK_MS } from '../../bus/netwatch.js'
import { NODE_CURSORS } from '../../bus/node.js'
import { keyOf, reviewCandidates } from '../../bus/queue.js'
import { fullReview } from '../../bus/review-depth.js'
import { ReviewExecutor } from '../../bus/review-executor.js'
import { DRY_RUN_ACTOR, ReviewNode, ReviewWorker, runReview } from '../../bus/review-worker.js'
import { reviewPrompt } from '../../bus/reviewer.js'
import { CARD_ADMITTED, NODE_DETECTED, NODE_EQUIVALENCE, REVIEW_RECORDED, TASK_ENQUEUED, TASK_RENEWED } from '../../core/events.js'
import { cardBody } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'
import { detectReview } from './review-detection.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

const passing: Reviewer = async lease => ({ verdict: 'pass', findings: [], session: `reviewer-${lease.pr}` })

class ProbedReviewNode extends ReviewNode {
  failOnCall: number | null = null
  private calls = 0

  found(scope?: Scope): string[] {
    return this.candidates(scope).map(keyOf)
  }

  protected override candidates(scope?: Scope): QueuedTask[] {
    this.calls += 1
    if (this.calls === this.failOnCall)
      throw new Error('injected in the middle of a batch')
    return super.candidates(scope)
  }

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }
}

class UngatedReviewNode extends ReviewNode {
  protected override before(): void {}
}

class DetectingReviewNode extends ProbedReviewNode {
  protected override before(): void {}

  protected override async handle(lease: Lease): Promise<Step> {
    return { kind: 'fenced', taskKey: lease.taskKey }
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function partsOf(made: MergeBench, mode: DetectionMode = 'shadow', reviewer: Reviewer = passing): ReviewNodeParts {
  return { db: made.db, gitHub: made.gitHub.client, publish: made.gitHub.publish, reviewer, plan: () => fullReview('a fixed plan'), clock: made.clock.now, session: 'node-1', mode, env: {}, isolation: sandboxed }
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow'): ProbedReviewNode {
  return new DetectingReviewNode(partsOf(made, mode))
}

async function once(node: ReviewNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

async function pausesOf(node: ReviewNode): Promise<number[]> {
  const controller = new AbortController()
  const pauses: number[] = []
  await node.run({
    pause: async (ms) => {
      pauses.push(ms)
      controller.abort()
    },
    signal: controller.signal,
  })
  return pauses
}

function headOf(pr: number): string {
  return pr.toString(16).padStart(40, '0')
}

function reviewKey(pr: number, head = headOf(pr), body: string = cardBody(pr), cardBodySha: string | null = null): string {
  return taskKey({ queue: 'review', cardId: pr + 100, pr, head, input: { prBody: prBodySha(body), cardBody: cardBodySha } })
}

function openGreen(made: MergeBench, pr: number, extra: { review?: 'success' | 'failure', required?: 'pending' | 'failure' } = {}): void {
  made.gitHub.open({ number: pr, head: headOf(pr), ...extra })
}

function changesOn(made: MergeBench, ...prs: number[]): void {
  for (const pr of prs)
    made.gitHub.pulls.get(pr)!.review = 'failure'
  made.tick()
}

function admitBody(made: MergeBench, cardId: number, bodySha: string): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:${bodySha}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}-${bodySha}`, bodySha }, legacy: false })
  return lastEventOf(made, CARD_ADMITTED)
}

function lastEventOf(made: MergeBench, type: string): number {
  const row = made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(type) as { id: number | null }
  return Number(row.id)
}

function detected(made: MergeBench, via: 'event' | 'tick'): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(each => each.via === via)
}

function keysOf(made: MergeBench, via: 'event' | 'tick'): string[] {
  return detected(made, via).map(each => String(each.key)).sort()
}

function derivedKeys(made: MergeBench): string[] {
  return reviewCandidates(made.db, made.clock.now().toISOString()).map(keyOf)
}

function reviewRows(made: MergeBench, pr: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'review' AND pr = ?`).get(pr) as { n: number }).n)
}

function enqueuedOf(made: MergeBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function cursorOf(made: MergeBench): number {
  return Number((made.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'review'`).get() as { event_id: number }).event_id)
}

function runOf(made: MergeBench, reviewer: Reviewer, pause: (ms: number) => Promise<unknown> = async () => {
  throw new Error('the node paused')
}): ReviewRun {
  return { busPath: made.busPath, gitHub: made.gitHub.client, publish: made.gitHub.publish, reviewer, plan: () => fullReview('a fixed plan'), session: 'run-1', slots: 1, pause, clearLeftovers: () => [], isolation: sandboxed }
}

describe('the review node', () => {
  it('a green open card pull request with no verdict on its head is detected by its event and by a tick', async () => {
    const made = bench()
    openGreen(made, 1010)
    made.tick()
    const node = nodeOf(made)
    await once(node)
    expect(keysOf(made, 'tick')).toEqual([reviewKey(1010)])
    expect(detected(made, 'event')).toEqual([])

    openGreen(made, 1011)
    made.tick()
    await once(node)
    expect(keysOf(made, 'event')).toContain(reviewKey(1011))
    expect(keysOf(made, 'tick')).toEqual([reviewKey(1010), reviewKey(1011)])
  })

  it('a new card body admitted after a changes verdict makes the pull request a candidate again, scoped by its card', async () => {
    const made = bench()
    openGreen(made, 1020)
    openGreen(made, 1021)
    made.tick()
    detectReview(made)
    changesOn(made, 1020, 1021)
    const node = nodeOf(made)
    await once(node)
    expect(node.found()).toEqual([reviewKey(1020), reviewKey(1021)])

    const cardBodySha = 'e'.repeat(64)
    const admitted = admitBody(made, 1120, cardBodySha)
    expect(node.found()).toEqual([reviewKey(1020, headOf(1020), cardBody(1020), cardBodySha), reviewKey(1021)])
    expect(node.found({ cardId: 1120 })).toEqual([reviewKey(1020, headOf(1020), cardBody(1020), cardBodySha)])
    expect(node.found({ cardId: 1121 })).toEqual([reviewKey(1021)])

    await once(node)
    expect(detected(made, 'event').filter(each => each.event_id === admitted)).toEqual([{ key: reviewKey(1020, headOf(1020), cardBody(1020), cardBodySha), via: 'event', event_id: admitted }])
  })

  it('the node finds what reviewCandidates finds on one snapshot, and shadow records node.equivalence of the node against reviewCandidates with nothing on one side only', async () => {
    const made = bench()
    openGreen(made, 1030)
    openGreen(made, 1031)
    openGreen(made, 1032, { required: 'failure' })
    openGreen(made, 1033, { required: 'pending' })
    openGreen(made, 1034, { review: 'success' })
    made.tick()
    detectReview(made)
    changesOn(made, 1031)
    const node = nodeOf(made)
    const keys = [reviewKey(1030), reviewKey(1031)]

    expect(derivedKeys(made)).toEqual(keys)
    expect(node.found()).toEqual(derivedKeys(made))
    expect(node.found({ pr: 1031 })).toEqual([reviewKey(1031)])

    const enqueued = keys.map(key => enqueuedOf(made, key))
    await once(node)
    expect(eventsOf(made.db, NODE_EQUIVALENCE)).toEqual([{ same: keys, only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(keys.map(key => enqueuedOf(made, key))).toEqual(enqueued)
  })

  it('i1: in live mode the node and deriveQueues detect one key, and there is one task row and one task.enqueued', async () => {
    const made = bench()
    const node = nodeOf(made, 'live')
    await once(node)
    expect(reviewRows(made, 1040)).toBe(0)

    openGreen(made, 1040)
    made.tick()
    await once(node)
    made.tick()
    await once(node)
    made.tick()

    expect(reviewRows(made, 1040)).toBe(1)
    expect(enqueuedOf(made, reviewKey(1040))).toBe(1)
  })

  it('i2: a failure in the middle of a batch rolls back the cursor with its records, and the restart detects each candidate once', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)
    const cursor = cursorOf(made)

    openGreen(made, 1050)
    openGreen(made, 1051)
    made.tick()
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    expect(detected(made, 'event')).toEqual([])
    expect(cursorOf(made)).toBe(cursor)

    await once(node)
    expect(keysOf(made, 'event')).toEqual([reviewKey(1050), reviewKey(1051)])
    expect(detected(made, 'event')).toHaveLength(2)
  })

  it('i3: a cursor reset to 0 gives no second detection and no second task', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const made = bench()
      const node = nodeOf(made, mode)
      await once(node)
      openGreen(made, 1060)
      made.tick()
      detectReview(made)
      await once(node)
      made.tick()
      await once(node)
      const counts = (): object => ({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, reviewKey(1060)), tasks: reviewRows(made, 1060) })
      const before = counts()
      expect(enqueuedOf(made, reviewKey(1060)), mode).toBe(1)

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect(counts(), mode).toEqual(before)
    }
  })

  it('three review tasks run at once in the three slots of one node through the ReviewExecutor, and no timer renews the lease while a review runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const made = bench()
    for (const pr of [1070, 1071, 1072, 1073])
      openGreen(made, pr)
    made.tick()
    detectReview(made)
    const reviewed = vi.spyOn(ReviewExecutor.prototype, 'review')
    const leases: Lease[] = []
    const gates: (() => void)[] = []
    const reviewer: Reviewer = lease => new Promise((resolve) => {
      leases.push(lease)
      gates.push(() => resolve({ verdict: 'pass', findings: [], session: `reviewer-${lease.pr}` }))
    })
    const node = new ReviewNode(partsOf(made, 'shadow', reviewer))
    const controller = new AbortController()

    const running = node.run({ pause: async () => controller.abort(), signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    expect(node.slots).toBe(3)
    expect(leases.map(lease => lease.pr)).toEqual([1070, 1071, 1072])
    expect(new Set(leases.map(lease => lease.actor))).toEqual(new Set(['worker:review:node-1']))
    expect(node.getState().leased).toEqual([reviewKey(1070), reviewKey(1071), reviewKey(1072)])
    expect(taskState(made.db, reviewKey(1073)).state).toBe('queued')
    expect(reviewed).toHaveBeenCalledTimes(3)

    made.clock.advance(RENEW_MS)
    vi.advanceTimersByTime(RENEW_MS)
    expect(eventsOf(made.db, TASK_RENEWED)).toHaveLength(0)

    for (const open of gates)
      open()
    await running
    expect(eventsOf(made.db, REVIEW_RECORDED).map(each => each.verdict)).toEqual(['pass', 'pass', 'pass'])
    expect([1070, 1071, 1072].map(pr => taskState(made.db, reviewKey(pr)).state)).toEqual(['completed', 'completed', 'completed'])
    expect(taskState(made.db, reviewKey(1073)).state).toBe('queued')
  })

  it('the review modes are kept beside the node: dry run, the start gate on an unclean shadow report, the waiting step with no failure and no pause after a recorded review', async () => {
    const made = bench()
    const reviewed: Lease[] = []
    const reviewer: Reviewer = async (lease) => {
      reviewed.push(lease)
      return { verdict: 'pass', findings: [], session: 'reviewer-modes' }
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    openGreen(made, 1080)
    const before = eventCount(made.db)

    expect(await runReview(['--dry-run', '1080'], runOf(made, reviewer))).toBe(0)
    expect(reviewed.map(lease => lease.actor)).toEqual([DRY_RUN_ACTOR])
    expect(eventCount(made.db)).toBe(before)

    expect(await runReview(['--on', '--dry-run', '1080'], runOf(made, reviewer))).toBe(1)
    expect(errors.mock.calls.at(-1)?.[0]).toContain('records nothing')

    const unclean = bench()
    unclean.gitHub.open({ number: 948 })
    unclean.tick()
    unclean.db.prepare(`UPDATE prs SET state = 'closed' WHERE pr = 948`).run()
    const pause = vi.fn(async () => {
      throw new Error('the node paused')
    })
    expect(await runReview(['--on'], runOf(unclean, reviewer, pause))).toBe(1)
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain('refused to start, the shadow report is not clean')
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain('replay byte-diff: prs 948: state live "closed", replay "open"')
    expect(pause).not.toHaveBeenCalled()
    expect(reviewed).toHaveLength(1)

    made.tick()
    detectReview(made)
    made.gitHub.pulls.get(1080)!.required = 'pending'
    const waiting = new UngatedReviewNode(partsOf(made, 'shadow', reviewer))
    expect(await pausesOf(waiting)).toEqual([TICK_MS, CHECK_MS])
    expect(taskState(made.db, reviewKey(1080))).toMatchObject({ state: 'queued', failures: 0 })
    expect(reviewed).toHaveLength(1)

    made.gitHub.pulls.get(1080)!.required = 'success'
    made.tick()
    const recording = new ReviewNode(partsOf(made, 'shadow', reviewer))
    expect(await pausesOf(recording)).toEqual([0, CHECK_MS])
    expect(eventsOf(made.db, REVIEW_RECORDED)).toHaveLength(1)
    expect(await pausesOf(new ReviewNode(partsOf(made, 'shadow', reviewer)))).toEqual([CHECK_MS])
  })

  it('a review of an old input and a task of an old head are handled by deriveQueues beside the node as before', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    openGreen(made, 1090)
    made.tick()
    detectReview(made)
    await once(node)
    made.gitHub.pulls.get(1090)!.body = `${cardBody(1090)}\nan edited description`
    made.tick()
    detectReview(made)
    await once(node)

    openGreen(made, 1091)
    made.tick()
    detectReview(made)
    made.gitHub.pulls.get(1091)!.head = headOf(6091)
    made.tick()
    detectReview(made)
    await once(node)

    const rows = (pr: number): unknown[] => made.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'review' AND pr = ? ORDER BY id`).all(pr)
    expect(rows(1090)).toEqual([{ task_key: reviewKey(1090), state: 'superseded' }, { task_key: reviewKey(1090, headOf(1090), `${cardBody(1090)}\nan edited description`), state: 'leased' }])
    expect(rows(1091)).toEqual([{ task_key: reviewKey(1091), state: 'superseded' }, { task_key: reviewKey(1091, headOf(6091)), state: 'leased' }])
  })

  // eslint-disable-next-line test/prefer-lowercase-title
  it('ReviewWorker.stepOn leases the named task and records its verdict through the same ReviewExecutor', async () => {
    const made = bench()
    openGreen(made, 1095)
    openGreen(made, 1096)
    made.tick()
    detectReview(made)
    const reviewed = vi.spyOn(ReviewExecutor.prototype, 'review')
    const worker = new ReviewWorker({ db: made.db, gitHub: made.gitHub.client, publish: made.gitHub.publish, reviewer: passing, plan: () => fullReview('a fixed plan'), clock: made.clock.now, session: 'worker-1', isolation: sandboxed })

    expect(await worker.stepOn(reviewKey(1096))).toMatchObject({ kind: 'recorded', taskKey: reviewKey(1096), verdict: 'pass' })
    expect(reviewed).toHaveBeenCalledTimes(1)
    expect(reviewed.mock.calls[0]![0]).toMatchObject({ taskKey: reviewKey(1096), actor: 'worker:review:worker-1' })
    expect(taskState(made.db, reviewKey(1096)).state).toBe('completed')
    expect(taskState(made.db, reviewKey(1095)).state).toBe('queued')
    expect(made.db.prepare('SELECT actor FROM events WHERE type = ?').all(REVIEW_RECORDED)).toEqual([{ actor: 'worker:review:worker-1' }])
  })

  it('the session input is rebuilt from review.recorded alone with no handoff directory', async () => {
    const made = bench()
    const root = mkdtempSync(path.join(tmpdir(), 'bus-review-input-'))
    try {
      openGreen(made, 1097)
      made.tick()
      detectReview(made)
      const since = 'b'.repeat(40)
      const plan: ReviewPlan = { depth: 'diff', round: 'first', why: 'a fixed plan', since, touchFindings: [] }
      let given = ''
      const reviewer = async (lease: Lease, planned: ReviewPlan): Promise<Review & { input: SessionInput }> => {
        given = reviewPrompt(lease, planned, '/trees/review-1097', '/verdicts/1097.json')
        return { verdict: 'pass', findings: [], session: `reviewer-${lease.pr}`, input: { prompt: given } }
      }
      const worker = new ReviewWorker({ db: made.db, gitHub: made.gitHub.client, publish: made.gitHub.publish, reviewer, plan: () => plan, clock: made.clock.now, session: 'worker-1', isolation: sandboxed, prompts: path.join(root, 'prompts') })

      expect(await worker.stepOn(reviewKey(1097))).toMatchObject({ kind: 'recorded', verdict: 'pass' })
      const [recorded] = eventsOf(made.db, REVIEW_RECORDED) as { head: string, since: string, prompt_sha: string, prompt_path: string }[]
      expect(existsSync(path.join(root, 'handoff'))).toBe(false)
      expect(recorded).toMatchObject({ head: headOf(1097), since })
      const rebuilt = readFileSync(recorded!.prompt_path, 'utf8')
      expect(rebuilt).toBe(given)
      expect(rebuilt).toContain(`${recorded!.since}..${recorded!.head}`)
      expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(recorded!.prompt_sha)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('review.recorded carries since only beside the stored input of a diff review, and keeps the verdict when the prompt cannot be stored', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-review-input-'))
    const blocker = path.join(root, 'a-file')
    writeFileSync(blocker, '')
    const since = 'b'.repeat(40)
    const diff: ReviewPlan = { depth: 'diff', round: 'first', why: 'a fixed plan', since, touchFindings: [] }
    const cases: { name: string, plan: ReviewPlan, input: boolean, prompts: string | undefined, fields: string[] }[] = [
      { name: 'diff, stored', plan: diff, input: true, prompts: path.join(root, 'prompts'), fields: ['prompt_path', 'prompt_sha', 'since'] },
      { name: 'full, stored', plan: fullReview('a fixed plan'), input: true, prompts: path.join(root, 'prompts'), fields: ['prompt_path', 'prompt_sha'] },
      { name: 'diff, no input', plan: diff, input: false, prompts: path.join(root, 'prompts'), fields: [] },
      { name: 'diff, no prompts directory', plan: diff, input: true, prompts: undefined, fields: [] },
      { name: 'diff, unwritable prompts directory', plan: diff, input: true, prompts: path.join(blocker, 'prompts'), fields: ['prompt_sha', 'prompt_unstored', 'since'] },
    ]
    try {
      for (const each of cases) {
        const made = bench()
        openGreen(made, 1097)
        made.tick()
        detectReview(made)
        const reviewer = async (lease: Lease): Promise<Review & { input?: SessionInput }> => ({ verdict: 'pass', findings: [], session: `reviewer-${lease.pr}`, ...(each.input ? { input: { prompt: 'the review prompt' } } : {}) })
        const worker = new ReviewWorker({ db: made.db, gitHub: made.gitHub.client, publish: made.gitHub.publish, reviewer, plan: () => each.plan, clock: made.clock.now, session: 'worker-1', isolation: sandboxed, prompts: each.prompts })

        expect(await worker.stepOn(reviewKey(1097)), each.name).toMatchObject({ kind: 'recorded', verdict: 'pass' })
        const [recorded] = eventsOf(made.db, REVIEW_RECORDED)
        expect(['prompt_path', 'prompt_sha', 'prompt_unstored', 'since'].filter(field => field in recorded!), each.name).toEqual(each.fields)
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
