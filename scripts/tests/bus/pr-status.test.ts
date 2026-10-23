import type { DatabaseSync } from 'node:sqlite'
import type { GitHubPost } from '../../bus/pr-status.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { TICK_MS } from '../../bus/netwatch.js'
import { PREFIX, setStepStatuses, STATUS_BATCH, STATUS_CONTEXT, STATUS_OFF_FILE } from '../../bus/pr-status.js'
import { composeBusTick } from '../../bus/run.js'
import { COMMAND_EXECUTED, PR_STATUS_REFUSED, PR_STATUS_SET } from '../../core/events.js'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { Clock, FakeGitHub } from './github-fake.js'

const HEAD = 'b'.repeat(40)
const NEXT = 'c'.repeat(40)
const NOW = new Date('2026-10-20T08:00:00.000Z')
const UNDER_FULL_SUITE_LOAD_MS = 5 * 60_000

function unopenedBus(): DatabaseSync {
  return openBus(path.join(mkdtempSync(path.join(tmpdir(), 'bus-pr-status-')), 'bus.db'))
}

function bus(): DatabaseSync {
  const db = unopenedBus()
  expect(setStepStatuses(db, recorder().post, () => NOW)).toEqual([])
  return db
}

function step(db: DatabaseSync, type: string, head: string | null, payload: Record<string, unknown>, actor = 'worker:review:s1'): void {
  appendEvent(db, { ts: NOW.toISOString(), type, actor, cardId: 1091, pr: 950, head, dedupeKey: `${type}:${JSON.stringify(payload)}:${head}`, payload, legacy: false })
}

function pullRequest(db: DatabaseSync, head: string, state: 'open' | 'closed' | 'merged'): void {
  step(db, 'test.pr', head, { state })
  db.prepare(`INSERT INTO prs (pr, card_id, head, state, event_id) VALUES (950, 1091, ?, ?, (SELECT max(id) FROM events))
    ON CONFLICT (pr) DO UPDATE SET head = excluded.head, state = excluded.state, event_id = excluded.event_id`).run(head, state)
}

function recorder(): { post: GitHubPost, calls: [string, Record<string, string>][] } {
  const calls: [string, Record<string, string>][] = []
  return { calls, post: (endpoint, fields) => {
    calls.push([endpoint, fields])
    return { status: 201, headers: {}, body: null }
  } }
}

function executedStatuses(db: DatabaseSync): unknown[] {
  return db.prepare(`SELECT json_extract(payload, '$.command') AS command, json_extract(payload, '$.endpoint') AS endpoint, json_extract(payload, '$.status') AS status FROM events WHERE type = ? ORDER BY id`).all(COMMAND_EXECUTED).map(row => ({ ...row }))
}

function count(db: DatabaseSync, type: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)
}

function tickedBus(): { db: DatabaseSync, busPath: string, root: string, clock: Clock } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-pr-status-'))
  vi.stubEnv(HANDOFF_DIR_VARIABLE, root)
  return { db: openBus(path.join(root, 'bus.db')), busPath: path.join(root, 'bus.db'), root, clock: new Clock() }
}

function openOn(head: string): FakeGitHub {
  const gitHub = new FakeGitHub()
  gitHub.open({ number: 950, head })
  return gitHub
}

describe('the PR status check the bus sets', () => {
  it('the bus sets the status check mikoshi: <step> on the PR head at each step', () => {
    const { db, busPath, root, clock } = tickedBus()
    const gitHub = openOn(HEAD)
    const { post, calls } = recorder()
    const { busTick } = composeBusTick(db, busPath, gitHub.client, post, clock.now, root)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    step(db, 'pr.opened', null, { pr: 950 }, 'worker:shift:1')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    step(db, 'review.recorded', HEAD, { head: HEAD, verdict: 'changes' })
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    gitHub.open({ number: 950, head: NEXT })
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
    expect(count(db, PR_STATUS_SET)).toBe(7)
    db.close()
    vi.unstubAllEnvs()
  })

  it('a closed pull request gets no status', () => {
    const db = bus()
    pullRequest(db, HEAD, 'closed')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    pullRequest(db, HEAD, 'merged')
    step(db, 'card.stopped', HEAD, { reason: 'fault' }, 'worker:launch:s4')
    const { post, calls } = recorder()
    expect(setStepStatuses(db, post, () => NOW)).toEqual([])
    expect(calls).toEqual([])
    pullRequest(db, HEAD, 'open')
    step(db, 'merge.done', HEAD, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['merged'])
  })

  it('a step on a head the open pull request has moved past gets no status', () => {
    const db = bus()
    pullRequest(db, NEXT, 'open')
    step(db, 'review.recorded', HEAD, { head: HEAD, verdict: 'changes' })
    step(db, 'review.recorded', NEXT, { head: NEXT, verdict: 'pass' })
    const { post, calls } = recorder()
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['review pass'])
    expect(calls.map(([endpoint]) => endpoint)).toEqual([`repos/{owner}/{repo}/statuses/${NEXT}`])
  })

  it('a first run on a journal with history makes no GitHub call for a closed pull request', () => {
    const db = unopenedBus()
    pullRequest(db, HEAD, 'open')
    for (let gen = 1; gen <= 50; gen += 1)
      step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: gen })
    pullRequest(db, HEAD, 'closed')
    const { post, calls } = recorder()
    expect(setStepStatuses(db, post, () => NOW)).toEqual([])
    expect(calls).toEqual([])
    pullRequest(db, HEAD, 'open')
    expect(setStepStatuses(db, post, () => NOW)).toEqual([])
    expect(calls).toEqual([])
    step(db, 'merge.done', HEAD, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['merged'])
    expect(calls).toHaveLength(1)
  })

  it(`a tick with 10000 events behind the cursor ends within N calls, N = ${STATUS_BATCH}, and the next tick takes the next N`, () => {
    const { db, busPath, root, clock } = tickedBus()
    const { post, calls } = recorder()
    const { busTick } = composeBusTick(db, busPath, openOn(HEAD).client, post, clock.now, root)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    for (let gen = 1; gen <= 10_000; gen += 1)
      step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: gen })
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(calls).toHaveLength(STATUS_BATCH)
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(calls).toHaveLength(2 * STATUS_BATCH)
    expect(count(db, PR_STATUS_SET)).toBe(2 * STATUS_BATCH)
    db.close()
    vi.unstubAllEnvs()
  }, UNDER_FULL_SUITE_LOAD_MS)

  it('with the status node switched off a tick makes no status call, and switched back on the next tick posts', () => {
    const { db, busPath, root, clock } = tickedBus()
    const { post, calls } = recorder()
    const { busTick } = composeBusTick(db, busPath, openOn(HEAD).client, post, clock.now, root)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    writeFileSync(path.join(path.dirname(busPath), STATUS_OFF_FILE), '')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(calls).toEqual([])
    rmSync(path.join(path.dirname(busPath), STATUS_OFF_FILE))
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(calls.map(([endpoint]) => endpoint)).toEqual([`repos/{owner}/{repo}/statuses/${HEAD}`])
    db.close()
    vi.unstubAllEnvs()
  })

  it('a bus tick whose status post GitHub refuses for now still ticks, and the next tick posts the step', () => {
    const { db, busPath, root, clock } = tickedBus()
    let status = 502
    const calls: string[] = []
    const lines: string[] = []
    const post: GitHubPost = (endpoint) => {
      calls.push(endpoint)
      return { status, headers: {}, body: null }
    }
    const { busTick } = composeBusTick(db, busPath, openOn(HEAD).client, post, clock.now, root)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    log.mockRestore()
    expect(lines).toContain(`${PREFIX}PR #950 ${HEAD}: GitHub answered 502 to the status ${STATUS_CONTEXT}: review; the step is not recorded and is posted again on the next run`)
    expect(count(db, PR_STATUS_SET)).toBe(0)
    expect(executedStatuses(db)).toEqual([{ command: 'status', endpoint: `repos/{owner}/{repo}/statuses/${HEAD}`, status: 502 }])
    status = 201
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(calls).toEqual([`repos/{owner}/{repo}/statuses/${HEAD}`, `repos/{owner}/{repo}/statuses/${HEAD}`])
    expect(count(db, PR_STATUS_SET)).toBe(1)
    expect(executedStatuses(db)).toEqual([502, 201].map(answered => ({ command: 'status', endpoint: `repos/{owner}/{repo}/statuses/${HEAD}`, status: answered })))
    db.close()
    vi.unstubAllEnvs()
  })

  it('the board a tick writes is projected after the statuses and shows what the same tick posted', () => {
    const { db, busPath, root, clock } = tickedBus()
    const post: GitHubPost = () => {
      step(db, 'card.fell', null, { reason: 'posted' }, 'worker:launch:s4')
      return { status: 201, headers: {}, body: null }
    }
    const { busTick, boardFile } = composeBusTick(db, busPath, openOn(HEAD).client, post, clock.now, root)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    expect(readFileSync(boardFile, 'utf8')).toContain('card #1091 fell')
    db.close()
    vi.unstubAllEnvs()
  })

  it('a bus tick whose status post breaks on something other than a GitHub answer logs it under the pr-status prefix and still ticks', () => {
    const { db, busPath, root, clock } = tickedBus()
    const lines: string[] = []
    const broken: GitHubPost = () => {
      throw new Error('spawnSync gh ENOENT')
    }
    const { busTick } = composeBusTick(db, busPath, openOn(HEAD).client, broken, clock.now, root)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    clock.advance(TICK_MS)
    expect(busTick.run()?.poll.kind).toBe('ticked')
    log.mockRestore()
    expect(lines).toContain(`${PREFIX}the status step broke and recorded nothing, the bus tick goes on: spawnSync gh ENOENT`)
    db.close()
    vi.unstubAllEnvs()
  })

  it('a 401, an expired or revoked token, records nothing and the step is posted on the next run', () => {
    const db = bus()
    pullRequest(db, HEAD, 'open')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    const unauthorized: GitHubPost = () => ({ status: 401, headers: {}, body: null })
    expect(() => setStepStatuses(db, unauthorized, () => NOW)).toThrow(/401/)
    expect(count(db, PR_STATUS_SET) + count(db, PR_STATUS_REFUSED)).toBe(0)
    const { post, calls } = recorder()
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['review'])
    expect(calls).toHaveLength(1)
  })

  it('a status GitHub refuses for good, a 422 on a head that is gone, is recorded as refused and the later steps are still posted', () => {
    const db = bus()
    pullRequest(db, HEAD, 'open')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    step(db, 'merge.done', HEAD, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    let calls = 0
    const gone: GitHubPost = () => {
      calls += 1
      return { status: calls === 1 ? 422 : 201, headers: {}, body: null }
    }
    expect(setStepStatuses(db, gone, () => NOW)).toEqual([
      { pr: 950, head: HEAD, step: 'review', state: 'pending', refused: 422 },
      { pr: 950, head: HEAD, step: 'merged', state: 'success' },
    ])
    expect(count(db, PR_STATUS_REFUSED)).toBe(1)
    const again = recorder()
    expect(setStepStatuses(db, again.post, () => NOW)).toEqual([])
    expect(again.calls).toEqual([])
  })

  it('a status GitHub refuses for now, a 5xx, is not recorded, so the cursor stays and the next run posts it again', () => {
    const db = bus()
    pullRequest(db, HEAD, 'open')
    step(db, 'task.leased', HEAD, { task_key: 'review:1091:950', queue: 'review', lease_gen: 1 })
    step(db, 'merge.done', HEAD, { commit: 'd'.repeat(40), rule: 'auto' }, 'worker:merge:s3')
    let calls = 0
    const refusing: GitHubPost = () => {
      calls += 1
      return { status: calls === 2 ? 502 : 201, headers: {}, body: null }
    }
    expect(() => setStepStatuses(db, refusing, () => NOW)).toThrow(/502/)
    expect(count(db, PR_STATUS_SET)).toBe(1)
    const { post, calls: retried } = recorder()
    expect(setStepStatuses(db, post, () => NOW).map(status => status.step)).toEqual(['merged'])
    expect(retried).toHaveLength(1)
  })
})
