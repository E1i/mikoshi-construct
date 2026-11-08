import type { DatabaseSync } from 'node:sqlite'
import type { BoardFiles } from '../../cli/board-page.js'
import type { MergeBench } from './merge-bench.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { boardProjection } from '../../cli/board-page.js'
import { boardWarnings, MainUpToDate, stalePassCountOf, stalePassText } from '../../cli/board-warnings.js'
import { appendEvent } from '../../core/db.js'
import { REVIEW_RECORDED, UPDATE_DONE } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { REVIEW_RULES_FILE, REVIEW_RULES_SHA, REVIEW_RULES_VERSION, ReviewExecutor, reviewRulesSha, SPAWNS_NO_SESSION } from '../../nodes/review/review-executor.js'
import { recordedVerdictOn, UpdateExecutor } from '../../nodes/update/update-executor.js'
import { sha } from './github-fake.js'
import { eventCount, eventsOf, liveBench } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const NEW_HEAD = sha('d')
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..')
const rulesText = (): string => readFileSync(path.join(REPOSITORY_ROOT, REVIEW_RULES_FILE), 'utf8')

function recordedVerdict(bench: MergeBench, pr: number, head: string, payload: Record<string, unknown>): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:worker-0', cardId: pr + 100, pr, head, dedupeKey: `${REVIEW_RECORDED}:seeded-${pr}-${head}:1`, payload: { head, findings: [], ...payload }, legacy: false })
}

function carriedVerdict(bench: MergeBench, pr: number, from: string, to: string, payload: Record<string, unknown>): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: UPDATE_DONE, actor: 'worker:update:worker-0', cardId: pr + 100, pr, head: from, dedupeKey: `${UPDATE_DONE}:seeded-${pr}`, payload: { from, to, clean: true, ...payload }, legacy: false })
}

function updated(bench: MergeBench): Record<string, unknown>[] {
  const executor = new UpdateExecutor({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {} })
  detectUpdate(bench)
  executor.update(leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!)
  return eventsOf(bench.db, UPDATE_DONE)
}

function projectedPage(bench: MergeBench): string {
  const written = new Map<string, string>()
  const files: BoardFiles = { write: (file, text) => written.set(file, text), rename: (from, to) => written.set(to, written.get(from)!) }
  const projection = boardProjection(bench.db, bench.busPath, 1_000, files, path.join(path.dirname(bench.busPath), 'handoff.md'), new MainUpToDate(bench.gitHub.client, () => bench.clock.now().getTime()))
  projection.project(bench.clock.now())
  return written.get(projection.file) ?? ''
}

function prRows(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT pr, head, state, verdict_on_head FROM prs ORDER BY pr').all()
}

describe('the version of the review rules on a verdict', () => {
  it('a recorded verdict carries the rules version', async () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 1701 })
    bench.tick()
    const executor = new ReviewExecutor({ db: bench.db, gitHub: bench.gitHub.client, publish: () => {}, reviewer: async () => ({ verdict: 'pass', findings: [], session: 'reviewer-1' }), plan: () => fullReview('a fixed plan'), clock: bench.clock.now, isolation: SPAWNS_NO_SESSION })

    expect(await executor.review(leaseNext(bench.db, bench.clock.now().toISOString(), 'review', 'worker:review:worker-1')!)).toMatchObject({ kind: 'recorded', verdict: 'pass' })
    expect(eventsOf(bench.db, REVIEW_RECORDED)).toMatchObject([{ verdict: 'pass', rules_version: REVIEW_RULES_VERSION }])
    expect(recordedVerdictOn(bench.db, 1701, sha('a'))).toEqual({ verdict: 'pass', rulesVersion: REVIEW_RULES_VERSION })
    bench.close()
  })

  it('the rules version is pinned to the review rules: changing them without recording their new sha and raising the version is red', () => {
    expect(reviewRulesSha(rulesText()), `the review rules changed: raise REVIEW_RULES_VERSION past ${REVIEW_RULES_VERSION} and record the new REVIEW_RULES_SHA`).toBe(REVIEW_RULES_SHA)
    expect(reviewRulesSha(`${rulesText()}\nA new rule.`)).not.toBe(REVIEW_RULES_SHA)
  })

  it('a carried pass keeps the version of the verdict it carries', () => {
    const versioned = liveBench()
    versioned.gitHub.open({ number: 1702, review: 'success', mergeable_state: 'behind', files: ['scripts/core/queue.ts'] })
    versioned.tick()
    recordedVerdict(versioned, 1702, sha('a'), { verdict: 'pass', rules_version: REVIEW_RULES_VERSION - 1 })

    expect(updated(versioned)).toMatchObject([{ from: sha('a'), to: NEW_HEAD, carried: 'pass', rules_version: REVIEW_RULES_VERSION - 1 }])
    expect(recordedVerdictOn(versioned.db, 1702, NEW_HEAD)).toEqual({ verdict: 'pass', rulesVersion: REVIEW_RULES_VERSION - 1 })
    versioned.close()

    const unversioned = liveBench()
    unversioned.gitHub.open({ number: 1703, review: 'success', mergeable_state: 'behind', files: ['scripts/core/queue.ts'] })
    unversioned.tick()
    recordedVerdict(unversioned, 1703, sha('a'), { verdict: 'pass' })

    expect(updated(unversioned)).toMatchObject([{ carried: 'pass', rules_version: null }])
    unversioned.close()
  })

  it('the board counts open pass verdicts under older rules', () => {
    const bench = liveBench()
    for (const pr of [1710, 1711, 1712, 1713, 1714])
      bench.gitHub.open({ number: pr, review: 'success', head: sha(String(pr % 10)) })
    bench.gitHub.open({ number: 1715, review: 'failure', head: sha('5') })
    bench.tick()
    recordedVerdict(bench, 1710, sha('0'), { verdict: 'pass', rules_version: REVIEW_RULES_VERSION })
    recordedVerdict(bench, 1711, sha('1'), { verdict: 'pass', rules_version: REVIEW_RULES_VERSION - 1 })
    recordedVerdict(bench, 1712, sha('2'), { verdict: 'pass' })
    carriedVerdict(bench, 1713, sha('e'), sha('3'), { carried: 'pass', rules_version: REVIEW_RULES_VERSION })
    carriedVerdict(bench, 1714, sha('e'), sha('4'), { carried: 'pass' })
    recordedVerdict(bench, 1715, sha('5'), { verdict: 'changes' })

    expect(stalePassCountOf(bench.db)).toBe(3)
    expect(projectedPage(bench)).toContain(stalePassText(3))
    expect(boardWarnings({ contexts: [], contextLimit: null, warnRatio: null, openPrs: 0, openPrLimit: null, ownerWaits: 0, stalls: [], savingOff: false, stalePasses: 2 })).toEqual([{ level: 'amber', text: stalePassText(2) }])
    expect(boardWarnings({ contexts: [], contextLimit: null, warnRatio: null, openPrs: 0, openPrLimit: null, ownerWaits: 0, stalls: [], savingOff: false, stalePasses: 0 })).toEqual([])
    expect(stalePassText(1)).toBe(`1 open pass verdict under review rules older than version ${REVIEW_RULES_VERSION}`)
    bench.close()
  })

  it('a stale pass is counted and not withdrawn', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 1720, review: 'success' })
    bench.tick()
    recordedVerdict(bench, 1720, sha('a'), { verdict: 'pass' })
    const events = eventCount(bench.db)
    const prs = prRows(bench.db)
    const stored = eventsOf(bench.db, REVIEW_RECORDED)

    expect(stalePassCountOf(bench.db)).toBe(1)
    expect(eventCount(bench.db)).toBe(events)
    expect(prRows(bench.db)).toEqual(prs)
    expect(eventsOf(bench.db, REVIEW_RECORDED)).toEqual(stored)
    expect(prs).toMatchObject([{ pr: 1720, state: 'open', verdict_on_head: 'pass' }])
    bench.close()
  })
})
