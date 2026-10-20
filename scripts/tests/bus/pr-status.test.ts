import type { DatabaseSync } from 'node:sqlite'
import type { GitHubPost } from '../../bus/pr-status.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { TICK_MS } from '../../bus/netwatch.js'
import { PR_STATUS_REFUSED, PR_STATUS_SET, PREFIX, setStepStatuses, STATUS_CONTEXT } from '../../bus/pr-status.js'
import { composeBusTick } from '../../bus/run.js'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { Clock, FakeGitHub } from './github-fake.js'

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
    const root = mkdtempSync(path.join(tmpdir(), 'bus-pr-status-'))
    vi.stubEnv(HANDOFF_DIR_VARIABLE, root)
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    const gitHub = new FakeGitHub()
    gitHub.open({ number: 950, head: HEAD })
    const clock = new Clock()
    const { post, calls } = recorder()
    const { busTick } = composeBusTick(db, busPath, gitHub.client, post, clock.now, root)
    step(db, 'pr.opened', null, { pr: 950 }, 'worker:shift:1')
    expect(busTick.run()?.poll.kind).toBe('ticked')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    step(db, 'review.recorded', HEAD, { head: HEAD, verdict: 'changes' })
    step(db, 'card.answered', NEXT, { from: HEAD, to: NEXT }, 'worker:answer:s2')
    step(db, 'review.recorded', NEXT, { head: NEXT, verdict: 'pass' })
    step(db, 'merge.done', NEXT, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    step(db, 'node.equivalence', null, { same: [] })
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(calls).toEqual([
      [`repos/{owner}/{repo}/statuses/${HEAD}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: opened' }],
      [`repos/{owner}/{repo}/statuses/${HEAD}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: review' }],
      [`repos/{owner}/{repo}/statuses/${HEAD}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: review changes' }],
      [`repos/{owner}/{repo}/statuses/${NEXT}`, { state: 'pending', context: STATUS_CONTEXT, description: 'mikoshi: answered' }],
      [`repos/{owner}/{repo}/statuses/${NEXT}`, { state: 'success', context: STATUS_CONTEXT, description: 'mikoshi: review pass' }],
      [`repos/{owner}/{repo}/statuses/${NEXT}`, { state: 'success', context: STATUS_CONTEXT, description: 'mikoshi: merged' }],
    ])
    clock.advance(TICK_MS)
    busTick.run()
    expect(calls).toHaveLength(6)
    step(db, 'card.stopped', NEXT, { reason: 'fault' }, 'worker:launch:s4')
    clock.advance(TICK_MS)
    busTick.run()
    expect(calls.at(-1)).toEqual([`repos/{owner}/{repo}/statuses/${NEXT}`, { state: 'failure', context: STATUS_CONTEXT, description: 'mikoshi: stopped' }])
    expect(Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(PR_STATUS_SET) as { n: number }).n)).toBe(7)
    db.close()
    vi.unstubAllEnvs()
  })

  it('a bus tick whose status post GitHub refuses for now still ticks, and the next tick posts the step', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-pr-status-'))
    vi.stubEnv(HANDOFF_DIR_VARIABLE, root)
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    const clock = new Clock()
    let status = 502
    const calls: string[] = []
    const post: GitHubPost = (endpoint) => {
      calls.push(endpoint)
      return { status, headers: {}, body: null }
    }
    const { busTick } = composeBusTick(db, busPath, new FakeGitHub().client, post, clock.now, root)
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(PR_STATUS_SET) as { n: number }).n)).toBe(0)
    status = 201
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(calls).toEqual([`repos/{owner}/{repo}/statuses/${HEAD}`, `repos/{owner}/{repo}/statuses/${HEAD}`])
    expect(Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(PR_STATUS_SET) as { n: number }).n)).toBe(1)
    db.close()
    vi.unstubAllEnvs()
  })

  it('a bus tick whose status post breaks on something other than a GitHub answer logs it under the pr-status prefix and still ticks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-pr-status-'))
    vi.stubEnv(HANDOFF_DIR_VARIABLE, root)
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    const clock = new Clock()
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    const broken: GitHubPost = () => {
      throw new Error('spawnSync gh ENOENT')
    }
    const { busTick } = composeBusTick(db, busPath, new FakeGitHub().client, broken, clock.now, root)
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    expect(busTick.run()?.poll.kind).toBe('ticked')
    log.mockRestore()
    expect(lines).toContain(`${PREFIX}the status step broke and recorded nothing, the bus tick goes on: spawnSync gh ENOENT`)
    db.close()
    vi.unstubAllEnvs()
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
