import type { GitHubPut } from '../../../ports/github.js'
import type { MergeBench } from '../merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../../core/db.js'
import { MERGE_DONE, REVIEW_RECORDED } from '../../../core/events.js'
import { reviewInputOf } from '../../../core/identifiers.js'
import { completeTask, leaseNext } from '../../../core/lease.js'
import { all as pullRequests } from '../../../core/pr-readings.js'
import { keyOf, queueTask, reviewCandidates } from '../../../core/queue.js'
import { mergeCandidates } from '../../../nodes/merge/merge-candidates.js'
import { MergeNode } from '../../../nodes/merge/merge-worker.js'
import { updateCandidates } from '../../../nodes/update/update-candidates.js'
import { recordDecision } from '../../../policy/decisions/index.js'
import { candidateRules, cardTransitions, updateParts } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { cardBody, sha } from '../github-fake.js'
import { eventsOf, mergeBench } from '../merge-bench.js'

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
})

const COUNT_LINE = '■ 4 □ 1 · 1'
const PR = 505
const CARD = PR + 100
const DECISION = 5320
const HEAD = sha('a')

interface Line {
  bench: MergeBench
  merge: MergeNode
  ts: () => string
}

function line(): Line {
  const bench = mergeBench()
  benches.push(bench)
  const ts = (): string => bench.clock.now().toISOString()
  appendEvent(bench.db, { ts: ts(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1, pr: 1, head: sha('f'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('f'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  recordDecision(bench.db, { ts: ts(), decisionId: 1, text: '[owner] allow-live merge', cards: [] })
  const put: GitHubPut = (endpoint, fields) => bench.gitHub.put(endpoint, fields)
  const merge = new MergeNode({ silentMs: SILENT_MS, db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, clock: bench.clock.now, mode: 'live', env: {}, put, session: 'merge-1', run: null })
  bench.gitHub.open({ number: PR, head: HEAD, review: 'success', files: ['docs/guide/o4-decided.md'], body: `${cardBody(PR)}\n\n${COUNT_LINE}` })
  bench.tick()
  return { bench, merge, ts }
}

async function once(node: MergeNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function merged(bench: MergeBench): number[] {
  return [...bench.gitHub.pulls.values()].filter(pull => pull.merged === true).map(pull => pull.number)
}

function stateOf(bench: MergeBench, key: string): unknown {
  return (bench.db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key) as { state: unknown } | undefined)?.state
}

function decide(line: Line, decisionId: number): void {
  recordDecision(line.bench.db, { ts: line.ts(), decisionId, text: `[owner] card #${CARD}: read this before it merges`, cards: [CARD] })
}

function reviewed(line: Line): void {
  appendEvent(line.bench.db, { ts: line.ts(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-2', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${REVIEW_RECORDED}:${PR}:after-the-decision`, payload: { head: HEAD, verdict: 'pass', reviewer_session: 'reviewer-2', findings: [] }, legacy: false })
}

describe('conveyor O4: a decision scoped to a card supersedes its merge and update tasks', () => {
  it('scenario 05: after decision.recorded scope:[card] while a merge is queued with a carried pass, the PR is not merged until a review under the decision key, then merged', async () => {
    const o4 = line()
    const { bench } = o4
    const [carried] = mergeCandidates(bench.db, o4.ts(), candidateRules())
    expect(carried).toMatchObject({ queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    expect(keyOf(carried!)).not.toContain(':decision-')
    expect(queueTask(bench.db, o4.ts(), carried!)).toBe(true)

    decide(o4, DECISION)
    bench.tick()

    expect(stateOf(bench, keyOf(carried!))).toBe('superseded')
    expect(mergeCandidates(bench.db, o4.ts(), candidateRules())).toEqual([])
    expect(reviewCandidates(bench.db, o4.ts(), candidateRules())).toEqual([expect.objectContaining({ queue: 'review', pr: PR, head: HEAD })])
    await once(o4.merge)
    expect(merged(bench)).toEqual([])

    reviewed(o4)
    bench.tick()
    expect(mergeCandidates(bench.db, o4.ts(), candidateRules()).map(keyOf)).toEqual([`${keyOf(carried!)}:decision-${DECISION}`])
    await once(o4.merge)

    expect(merged(bench)).toEqual([PR])
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([expect.objectContaining({ task_key: `${keyOf(carried!)}:decision-${DECISION}` })])
  })

  it('a review the card\'s head completed before the decision is queued again under it, once', () => {
    const o4 = line()
    const { bench } = o4
    const { body_sha: prBody } = bench.db.prepare('SELECT body_sha FROM prs WHERE pr = ?').get(PR) as { body_sha: string }
    const review = { queue: 'review' as const, cardId: CARD, pr: PR, head: HEAD, input: reviewInputOf(prBody, null) }
    queueTask(bench.db, o4.ts(), review)
    const lease = leaseNext(bench.db, pullRequests(bench.db), o4.ts(), 'review', 'worker:review:reviewer-1')!
    completeTask(bench.db, cardTransitions(), o4.ts(), lease, [])
    expect(stateOf(bench, keyOf(review))).toBe('completed')

    decide(o4, DECISION)
    bench.tick()
    expect(stateOf(bench, keyOf(review))).toBe('queued')
    const again = leaseNext(bench.db, pullRequests(bench.db), o4.ts(), 'review', 'worker:review:reviewer-1')!
    completeTask(bench.db, cardTransitions(), o4.ts(), again, [])
    bench.tick()
    expect(stateOf(bench, keyOf(review))).toBe('completed')

    reviewed(o4)
    bench.tick()
    expect(stateOf(bench, keyOf(review))).toBe('completed')
    const afterThePass = reviewCandidates(bench.db, o4.ts(), candidateRules()).filter(task => task.pr === PR)
    expect(afterThePass.map(keyOf)).toEqual([keyOf(review)])
    expect(afterThePass.map(task => queueTask(bench.db, o4.ts(), task))).toEqual([false])
    expect(stateOf(bench, keyOf(review))).toBe('completed')
  })

  it('an update task carries the latest decision naming its card, and a later one supersedes it', () => {
    const o4 = line()
    const { bench } = o4
    decide(o4, DECISION)
    const update = { queue: 'update' as const, cardId: CARD, pr: PR, head: HEAD, decision: DECISION }
    expect(queueTask(bench.db, o4.ts(), update)).toBe(true)
    bench.tick()
    expect(stateOf(bench, keyOf(update))).toBe('queued')

    decide(o4, DECISION + 1)
    bench.tick()

    expect(stateOf(bench, keyOf(update))).toBe('superseded')
    expect(updateCandidates(bench.db, o4.ts(), updateParts()).every(task => task.decision === DECISION + 1)).toBe(true)
  })
})
