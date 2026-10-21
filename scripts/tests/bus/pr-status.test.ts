import type { DatabaseSync } from 'node:sqlite'
import type { GitHubPost } from '../../bus/pr-status.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { PR_STATUS_REFUSED, PR_STATUS_SET, setStepStatuses, STATUS_CONTEXT } from '../../bus/pr-status.js'

const HEAD = 'b'.repeat(40)
const NEXT = 'c'.repeat(40)
const NOW = new Date('2026-10-20T08:00:00.000Z')

function bus(): DatabaseSync {
  return openBus(path.join(mkdtempSync(path.join(tmpdir(), 'bus-pr-status-')), 'bus.db'))
}

function step(db: DatabaseSync, type: string, head: string | null, payload: Record<string, unknown>, actor = 'worker:review:s1'): void {
  appendEvent(db, { ts: NOW.toISOString(), type, actor, cardId: 1091, pr: 950, head, dedupeKey: `${type}:${JSON.stringify(payload)}:${head}`, payload, legacy: false })
}

function recorder(): { post: GitHubPost, calls: [string, Record<string, string>][] } {
  const calls: [string, Record<string, string>][] = []
  return { calls, post: (endpoint, fields) => {
    calls.push([endpoint, fields])
    return { status: 201, headers: {}, body: null }
  } }
}

describe('the PR status check the bus sets', () => {
  it('the bus sets the status check mikoshi: <step> on the PR head at each step', () => {
    const db = bus()
    step(db, 'pr.opened', null, { pr: 950 }, 'netwatch')
    db.prepare('INSERT INTO prs (pr, card_id, head, state, event_id) VALUES (?, ?, ?, ?, (SELECT max(id) FROM events))').run(950, 1091, HEAD, 'open')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    step(db, 'review.recorded', HEAD, { head: HEAD, verdict: 'changes' })
    step(db, 'card.answered', NEXT, { from: HEAD, to: NEXT }, 'worker:answer:s2')
    step(db, 'review.recorded', NEXT, { head: NEXT, verdict: 'pass' })
    step(db, 'merge.done', NEXT, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    step(db, 'node.equivalence', null, { same: [] })
    const { post, calls } = recorder()
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['opened', 'review', 'review changes', 'answered', 'review pass', 'merged'])
    expect(calls).toEqual([
      [`repos/{owner}/{repo}/statuses/${HEAD}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: opened' }],
      [`repos/{owner}/{repo}/statuses/${HEAD}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: review' }],
      [`repos/{owner}/{repo}/statuses/${HEAD}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: review changes' }],
      [`repos/{owner}/{repo}/statuses/${NEXT}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: answered' }],
      [`repos/{owner}/{repo}/statuses/${NEXT}`, { state: 'success', context: STATUS_CONTEXT, description: 'mikoshi: review pass' }],
      [`repos/{owner}/{repo}/statuses/${NEXT}`, { state: 'success', context: STATUS_CONTEXT, description: 'mikoshi: merged' }],
    ])
    const again = recorder()
    expect(setStepStatuses(db, again.post, () => NOW)).toEqual([])
    expect(again.calls).toEqual([])
    step(db, 'card.stopped', NEXT, { reason: 'fault' }, 'worker:launch:s4')
    const stopped = recorder()
    expect(setStepStatuses(db, stopped.post, () => NOW)).toEqual([{ pr: 950, head: NEXT, step: 'stopped', state: 'failure' }])
    expect(Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(PR_STATUS_SET) as { n: number }).n)).toBe(7)
  })

  it('a 401, an expired or revoked token, records nothing and the step is posted on the next run', () => {
    const db = bus()
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    const unauthorized: GitHubPost = () => ({ status: 401, headers: {}, body: null })
    expect(() => setStepStatuses(db, unauthorized, () => NOW)).toThrow(/401/)
    expect(Number((db.prepare('SELECT count(*) AS n FROM events WHERE type IN (?, ?)').get(PR_STATUS_SET, PR_STATUS_REFUSED) as { n: number }).n)).toBe(0)
    const { post, calls } = recorder()
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['review'])
    expect(calls).toHaveLength(1)
  })

  it('a status GitHub refuses for good, a 422 on a head that is gone, is recorded as refused and the later steps are still posted', () => {
    const db = bus()
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    step(db, 'merge.done', NEXT, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    const gone: GitHubPost = endpoint => ({ status: endpoint.endsWith(HEAD) ? 422 : 201, headers: {}, body: null })
    expect(setStepStatuses(db, gone, () => NOW)).toEqual([
      { pr: 950, head: HEAD, step: 'review', state: 'pending', refused: 422 },
      { pr: 950, head: NEXT, step: 'merged', state: 'success' },
    ])
    expect(Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(PR_STATUS_REFUSED) as { n: number }).n)).toBe(1)
    const { post, calls } = recorder()
    expect(setStepStatuses(db, post, () => NOW)).toEqual([])
    expect(calls).toEqual([])
  })

  it('a status GitHub refuses for now, a 5xx, is not recorded, so the cursor stays and the next run posts it again', () => {
    const db = bus()
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    step(db, 'merge.done', HEAD, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    let calls = 0
    const refusing: GitHubPost = () => {
      calls += 1
      return { status: calls === 2 ? 502 : 201, headers: {}, body: null }
    }
    expect(() => setStepStatuses(db, refusing, () => NOW)).toThrow(/502/)
    expect(Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(PR_STATUS_SET) as { n: number }).n)).toBe(1)
    const { post, calls: retried } = recorder()
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['merged'])
    expect(retried).toHaveLength(1)
  })
})
