import type { CloseOutcome } from '../../bus/close-executor.js'
import type { GitHubPut } from '../../bus/github.js'
import type { Lease } from '../../bus/lease.js'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseExecutor } from '../../bus/close-executor.js'
import { runCloseWorker, shiftReportVerification } from '../../bus/close-worker.js'
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox } from '../../bus/inbox.js'
import { expireLeases, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { CARD_CLOSED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { sha } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const close = (pr: number, head = sha('a')): string => taskKey({ queue: 'close', cardId: pr + 100, pr, head })

function closeBench(reported: Record<number, string> = {}) {
  const bench = mergeBench()
  const patched: { endpoint: string, fields: Record<string, string> }[] = []
  let patchStatus = 200
  const patch: GitHubPut = (endpoint, fields) => {
    patched.push({ endpoint, fields })
    return { status: patchStatus, headers: {}, body: {} }
  }
  const executor = new CloseExecutor({ db: bench.db, patch, reported: cardId => reported[cardId] ?? null, clock: bench.clock.now })
  return {
    ...bench,
    patched,
    failPatch: (status: number) => {
      patchStatus = status
    },
    merged: (pr: number) => {
      bench.gitHub.open({ number: pr })
      bench.tick()
      bench.gitHub.close(pr, true)
      bench.tick()
    },
    leaseClose: (actor = 'worker:close:worker-1'): Lease | null => leaseNext(bench.db, bench.clock.now().toISOString(), 'close', actor),
    closeCard: (lease: Lease): CloseOutcome => executor.close(lease),
  }
}

function closedCard(bench: ReturnType<typeof mergeBench>, cardId: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

describe('the close queue', () => {
  it('a merged PR whose card is not closed enters close', () => {
    const bench = closeBench()
    bench.merged(990)

    expect(taskState(bench.db, close(990))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(bench.lease()).toBeNull()
    expect(bench.leaseClose()).toMatchObject({ taskKey: close(990), queue: 'close', cardId: 1090, pr: 990, head: sha('a'), leaseGen: 1 })
    bench.close()
  })

  it('a PR closed without merge and an already closed card do not enter close', () => {
    const bench = closeBench()
    bench.gitHub.open({ number: 991 })
    bench.gitHub.open({ number: 992 })
    bench.tick()
    closedCard(bench, 1092)
    bench.gitHub.close(991, false)
    bench.gitHub.close(992, true)
    bench.tick()

    expect(bench.db.prepare('SELECT pr, state FROM prs ORDER BY pr').all()).toEqual([{ pr: 991, state: 'closed' }, { pr: 992, state: 'merged' }])
    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'close'`).all()).toEqual([])
    expect(bench.leaseClose()).toBeNull()
    bench.close()
  })

  it('close records card.closed with the verification the run reported', () => {
    const bench = closeBench({ 1093: 'mutation' })
    bench.merged(993)

    expect(bench.closeCard(bench.leaseClose()!)).toEqual({ kind: 'closed', taskKey: close(993), verification: 'mutation' })
    expect(bench.patched).toEqual([{ endpoint: 'repos/{owner}/{repo}/issues/1093', fields: { state: 'closed', state_reason: 'completed' } }])
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([{ verification: 'mutation' }])
    expect(taskState(bench.db, close(993))).toEqual({ state: 'completed', lease_gen: 1, failures: 0 })

    bench.tick()
    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'close' AND state = 'queued'`).all()).toEqual([])
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a run that reported no verification word closes nothing and takes no default', () => {
    for (const [pr, reported, named] of [[994, {}, 'no verification'], [995, { 1095: 'tests' }, '\'tests\'']] as const) {
      const bench = closeBench(reported)
      bench.merged(pr)

      expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'denied', taskKey: close(pr), denial: { kind: 'technical', reason: 'no_verification', detail: expect.stringContaining(named) }, next: 'queued' })
      expect(bench.patched).toEqual([])
      expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([])
      expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'close', reason: 'no_verification' }])
      expect(ownerInbox(bench.db)).toEqual([])
      bench.close()
    }
  })

  it('an issue GitHub does not close is a github_error and records no card.closed', () => {
    const bench = closeBench({ 1096: 'run' })
    bench.merged(996)
    bench.failPatch(403)

    expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'denied', denial: { reason: 'github_error' }, next: 'queued' })
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([])
    expect(taskState(bench.db, close(996))).toEqual({ state: 'queued', lease_gen: 1, failures: 1 })
    bench.close()
  })

  it('a card closed after its task was leased withdraws the task and closes nothing', () => {
    const bench = closeBench({ 1097: 'run' })
    bench.merged(997)
    const lease = bench.leaseClose()!
    closedCard(bench, 1097)

    expect(bench.closeCard(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'card_closed' }, next: 'withdrawn' })
    expect(bench.patched).toEqual([])
    expect(eventsOf(bench.db, CARD_CLOSED)).toHaveLength(1)
    bench.close()
  })

  it('a close with a stale lease_gen is refused and writes nothing', () => {
    const bench = closeBench({ 1098: 'run' })
    bench.merged(998)
    const stale = bench.leaseClose('worker:close:old')!
    bench.clock.advance(LEASE_MS + 1)
    expireLeases(bench.db, bench.clock.now().toISOString())
    const current = bench.leaseClose('worker:close:new')!
    expect(current.leaseGen).toBe(stale.leaseGen + 1)
    const before = eventCount(bench.db)

    expect(bench.closeCard(stale)).toEqual({ kind: 'fenced', taskKey: close(998) })
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.patched).toEqual([])
    expect(taskState(bench.db, close(998))).toMatchObject({ state: 'leased', lease_gen: current.leaseGen })
    bench.close()
  })

  it('the verification comes from the newest shift report of the card', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-close-shift-'))
    const write = (lane: string, text: string, mtime: number): void => {
      mkdirSync(path.join(root, lane), { recursive: true })
      const file = path.join(root, lane, 'report-811.md')
      writeFileSync(file, text)
      utimesSync(file, new Date(mtime), new Date(mtime))
    }
    write('lane-1', '#811 card\nverification: code-reading\n', Date.parse('2026-10-09T00:00:00Z'))
    write('lane-2', '#811 card\nverification: run\n', Date.parse('2026-10-10T00:00:00Z'))
    write('lane-3', '#812 card\n', Date.parse('2026-10-10T00:00:00Z'))

    const reported = shiftReportVerification(root)
    expect(reported(811)).toBe('run')
    expect(reported(813)).toBeNull()
    expect(shiftReportVerification(path.join(root, 'absent'))(811)).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  it('the close worker is switched off without --on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const patch: GitHubPut = () => {
      throw new Error('a switched-off worker calls GitHub')
    }
    expect(await runCloseWorker([], { busPath: '/nonexistent/bus.db', patch, reported: () => null, session: 's', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
  })
})
