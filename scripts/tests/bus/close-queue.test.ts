import type { CloseOutcome } from '../../bus/close-executor.js'
import type { Lease } from '../../bus/lease.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloseExecutor } from '../../bus/close-executor.js'
import { CloseWorker, runCloseWorker, shiftReportVerification } from '../../bus/close-worker.js'
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox } from '../../bus/inbox.js'
import { expireLeases, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { CARD_CLOSED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { appendToJournal, journalLine } from '../../ghosts/task-merged.js'
import { MAIN_2, sha } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const close = (pr: number, head = sha('a')): string => taskKey({ queue: 'close', cardId: pr + 100, pr, head })

function closeBench(reported: Record<number, string> = {}) {
  const bench = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'bus-close-cycle-'))
  const journal = path.join(root, 'handoff', 'ghosts.jsonl')
  const parking = path.join(root, 'parking')
  const executor = new CloseExecutor({ db: bench.db, reported: cardId => reported[cardId] ?? null, clock: bench.clock.now, journal, parking })
  return {
    ...bench,
    journal,
    parking,
    park: (cardId: number, lane = 'lane-bus-1'): string => {
      mkdirSync(path.join(parking, lane), { recursive: true })
      const file = path.join(parking, lane, `${cardId}.md`)
      writeFileSync(file, `card: #${cardId}\n`)
      return file
    },
    mergeLines: (): Record<string, unknown>[] => existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.event === 'merge') : [],
    close: () => {
      bench.close()
      rmSync(root, { recursive: true, force: true })
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

    const lease = bench.leaseClose()!
    const calls = bench.gitHub.calls.length

    expect(bench.closeCard(lease)).toEqual({ kind: 'closed', taskKey: close(993), verification: 'mutation', cycle: { mergeLine: 'written', cardFile: 'absent' } })
    expect(bench.gitHub.calls).toHaveLength(calls)
    expect(bench.gitHub.puts).toEqual([])
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
      expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([])
      expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'close', reason: 'no_verification' }])
      expect(ownerInbox(bench.db)).toEqual([])
      bench.close()
    }
  })

  it('close makes no GitHub write, even for a card whose number is another pull request', () => {
    const bench = closeBench({ 1096: 'run' })
    bench.gitHub.open({ number: 1096 })
    bench.merged(996)
    const lease = bench.leaseClose()!
    const calls = bench.gitHub.calls.length

    expect(bench.closeCard(lease)).toMatchObject({ kind: 'closed', verification: 'run' })
    expect(bench.gitHub.calls).toHaveLength(calls)
    expect(bench.gitHub.puts).toEqual([])
    bench.tick()
    expect(bench.db.prepare('SELECT pr, state FROM prs ORDER BY pr').all()).toEqual([{ pr: 996, state: 'merged' }, { pr: 1096, state: 'open' }])
    bench.close()
  })

  it('a card closed after its task was leased withdraws the task and closes nothing', () => {
    const bench = closeBench({ 1097: 'run' })
    bench.merged(997)
    const lease = bench.leaseClose()!
    closedCard(bench, 1097)

    expect(bench.closeCard(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'card_closed' }, next: 'withdrawn' })
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
    const parked = bench.park(1098)

    expect(bench.closeCard(stale)).toEqual({ kind: 'fenced', taskKey: close(998) })
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.mergeLines()).toEqual([])
    expect(existsSync(parked)).toBe(true)
    expect(taskState(bench.db, close(998))).toMatchObject({ state: 'leased', lease_gen: current.leaseGen })
    bench.close()
  })

  it('a merged card PR ends with the card in archive and a merge line in the journal, with no manual command', () => {
    const bench = closeBench({ 1100: 'run' })
    const parked = bench.park(1100)
    bench.merged(1000)
    const calls = bench.gitHub.calls.length

    const worker = new CloseWorker({ db: bench.db, reported: () => 'run', clock: bench.clock.now, session: 'cycle', journal: bench.journal, parking: bench.parking })
    expect(worker.step()).toMatchObject({ kind: 'closed', verification: 'run', cycle: { mergeLine: 'written', cardFile: 'moved' } })
    expect(bench.gitHub.calls).toHaveLength(calls)
    expect(bench.gitHub.puts).toEqual([])
    expect(existsSync(parked)).toBe(false)
    expect(readFileSync(path.join(bench.parking, 'archive', '1100.md'), 'utf8')).toBe('card: #1100\n')
    const pullClosed = bench.db.prepare(`SELECT ts FROM events WHERE type = 'pr.closed' AND pr = 1000`).get() as { ts: string }
    expect(bench.mergeLines()).toEqual([{ event: 'merge', task: '1100', pr: 1000, by: 'netwatch', commit: MAIN_2, merged: pullClosed.ts, ts: bench.clock.now().toISOString() }])
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([{ verification: 'run' }])
    bench.close()
  })

  it('a retried close after a partial cycle writes no second merge line and moves nothing twice', () => {
    const bench = closeBench({ 1101: 'run', 1102: 'run' })
    const parked = bench.park(1101)
    bench.park(1102)
    bench.merged(1001)
    bench.merged(1002)
    const crashed = [bench.leaseClose('worker:close:crashed')!, bench.leaseClose('worker:close:crashed')!]
    appendToJournal(bench.journal, journalLine({ event: 'merge', task: '1101', pr: 1001, by: 'netwatch', commit: MAIN_2, ts: bench.clock.now().toISOString() }))
    appendToJournal(bench.journal, journalLine({ event: 'merge', task: '1102', pr: 1002, by: 'netwatch', commit: MAIN_2, ts: bench.clock.now().toISOString() }))
    mkdirSync(path.join(bench.parking, 'archive'), { recursive: true })
    renameSync(path.join(bench.parking, 'lane-bus-1', '1102.md'), path.join(bench.parking, 'archive', '1102.md'))
    bench.clock.advance(LEASE_MS + 1)
    expect(expireLeases(bench.db, bench.clock.now().toISOString())).toEqual(crashed.map(lease => lease.taskKey))

    expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'closed', taskKey: close(1001), cycle: { mergeLine: 'present', cardFile: 'moved' } })
    expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'closed', taskKey: close(1002), cycle: { mergeLine: 'present', cardFile: 'archived' } })
    expect(bench.mergeLines().map(line => line.pr)).toEqual([1001, 1002])
    expect(existsSync(parked)).toBe(false)
    expect(readdirSync(path.join(bench.parking, 'archive')).sort()).toEqual(['1101.md', '1102.md'])
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([{ verification: 'run' }, { verification: 'run' }])
    expect(bench.leaseClose()).toBeNull()
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
    expect(await runCloseWorker([], { busPath: '/nonexistent/bus.db', reported: () => null, session: 's', journal: '/nonexistent/ghosts.jsonl', parking: '/nonexistent/parking', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
  })
})
