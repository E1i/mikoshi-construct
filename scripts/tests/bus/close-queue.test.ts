import type { CloseOutcome } from '../../bus/close-executor.js'
import type { CloseNodeParts } from '../../bus/close-worker.js'
import type { Lease } from '../../bus/lease.js'
import type { NodeStep } from '../../bus/node.js'
import type { TaskCloseDeps } from '../../ghosts/task-close.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { CloseExecutor } from '../../bus/close-executor.js'
import { CloseNode, closingVerification, runCloseWorker } from '../../bus/close-worker.js'
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { legacyEventOf } from '../../bus/import.js'
import { CARD_STARTED, ownerInbox } from '../../bus/inbox.js'
import { CARD_ADMITTED, launchCandidates } from '../../bus/launch-candidates.js'
import { expireLeases, failTask, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { PR_CLOSED } from '../../bus/observations.js'
import { BOARD_ALARM, CARD_CLOSED, FAILURES_TO_STOP, queueTask, TASK_REQUEUED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { CARD_VERIFIED, runTaskClose } from '../../ghosts/task-close.js'
import { appendToJournal, journalLine } from '../../ghosts/task-merged.js'
import { writeLaneJson } from '../../lanes/lane-json.js'
import { detectClose } from './close-detection.js'
import { MAIN_2, MERGER, sha } from './github-fake.js'
import { cardVerified, eventCount, eventsOf, mergeBench, spendReviewRounds, taskState } from './merge-bench.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const AFTER_HISTORY = new Date('2026-10-13T18:00:00.000Z')

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
    merged: (pr: number, withVerified = true) => {
      bench.gitHub.open({ number: pr })
      bench.tick()
      if (withVerified)
        verified(bench, pr)
      bench.gitHub.close(pr, true)
      bench.tick()
      detectClose(bench.db, bench.clock.now)
    },
    leaseClose: (actor = 'worker:close:worker-1'): Lease | null => leaseNext(bench.db, bench.clock.now().toISOString(), 'close', actor),
    closeCard: (lease: Lease): CloseOutcome => executor.close(lease),
  }
}

function verified(bench: ReturnType<typeof mergeBench>, pr: number, verification = 'run'): void {
  cardVerified(bench.db, bench.clock.now().toISOString(), pr + 100, pr, verification)
}

function closedCard(bench: ReturnType<typeof mergeBench>, cardId: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

function reviewed(bench: ReturnType<typeof mergeBench>, pr: number, head: string, verdict: 'pass' | 'changes'): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: pr + 100, pr, head, dedupeKey: `${REVIEW_RECORDED}:${pr}:${head}`, payload: { head, verdict, reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
}

function windowStartLine(cardId: number): string {
  return JSON.stringify({ event: 'path', task: String(cardId), path: 'cheap', started: '2026-10-11T17:00:00.000Z', who: 'window', card: { id: cardId, name: `card-${cardId}`, kind: 'implement', milestone: 'bus', size: 'S', contour: 'cheap', decision: 'auto', depends: [], blocks: [], line: `#${cardId}` } })
}

function taskCloseDeps(handoffDir: string, now = new Date('2026-10-11T18:00:00.000Z')): TaskCloseDeps {
  return {
    cwd: handoffDir,
    read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    now: () => now,
    handoffDir,
    constructDir: handoffDir,
    realpath: file => file,
    exists: () => false,
    session: undefined,
    projectsDir: handoffDir,
    tokens: () => null,
    prBody: () => null,
  }
}

function closeNode(parts: Omit<CloseNodeParts, 'mode' | 'env'>): CloseNode {
  return new CloseNode({ ...parts, mode: 'shadow', env: {} })
}

async function step(node: CloseNode): Promise<NodeStep | null> {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  return node.getState().lastStep
}

describe('the close queue', () => {
  it('a merged PR whose card is not closed and holds card.verified enters close', () => {
    const bench = closeBench()
    bench.merged(990)

    expect(taskState(bench.db, close(990))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(bench.lease()).toBeNull()
    expect(bench.leaseClose()).toMatchObject({ taskKey: close(990), queue: 'close', cardId: 1090, pr: 990, head: sha('a'), leaseGen: 1 })
    bench.close()
  })

  it('a merged PR with no card.verified does not enter close', () => {
    const bench = closeBench({ 1089: 'run' })
    bench.merged(989, false)

    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'close'`).all()).toEqual([])
    expect(bench.leaseClose()).toBeNull()
    bench.close()
  })

  it.each([
    { only: 'a legacy card.verified of its own card and PR', cardId: 1087, pr: 987, legacy: true },
    { only: 'a card.verified of another PR of its card', cardId: 1087, pr: 986, legacy: false },
    { only: 'a card.verified of another card for its PR', cardId: 1086, pr: 987, legacy: false },
  ])('a merged PR whose only card.verified is $only does not enter close', ({ cardId, pr, legacy }) => {
    const bench = closeBench()
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId, pr, head: null, dedupeKey: `${CARD_VERIFIED}:${cardId}:${pr}:run`, payload: { path: 'cheap', pr, verification: 'run' }, legacy })
    bench.merged(987, false)

    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'close'`).all()).toEqual([])
    expect(bench.leaseClose()).toBeNull()
    bench.close()
  })

  it('card.verified written after the merge brings the card into close and card.closed carries its verification', async () => {
    const bench = closeBench()
    bench.merged(988, false)
    expect(bench.leaseClose()).toBeNull()
    verified(bench, 988, 'code-reading')
    bench.tick()
    detectClose(bench.db, bench.clock.now)

    const worker = closeNode({ db: bench.db, reported: closingVerification(bench.busPath), clock: bench.clock.now, session: 'window', journal: bench.journal, parking: bench.parking })
    expect(await step(worker)).toMatchObject({ kind: 'closed', taskKey: close(988), verification: 'code-reading' })
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([{ verification: 'code-reading' }])
    bench.close()
  })

  it('a card verified on a shared PR gets card.closed and gives up its lane', () => {
    const bench = closeBench({ 1120: 'run', 1121: 'code-reading' })
    const ts = bench.clock.now().toISOString()
    const admitted = (cardId: number): void => {
      appendEvent(bench.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-bus-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
    }
    admitted(1121)
    appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 1121, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1121`, payload: { session: 'card-session-1121', worktree: path.join(bench.parking, 'tree-1121'), branch: 'feat/card-1121', base: sha('1') }, legacy: false })
    admitted(1123)
    bench.tick()
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = 1121').get()).toEqual({ state: 'running' })
    expect(launchCandidates(bench.db, () => false).map(candidate => candidate.cardId)).not.toContain(1123)
    const parked = bench.park(1121)
    appendEvent(bench.db, { ts, type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId: 1121, pr: 1020, head: null, dedupeKey: `${CARD_VERIFIED}:1121:1020`, payload: { path: 'cheap', pr: 1020, sharedBy: 'D-189', verification: 'code-reading' }, legacy: false })
    bench.merged(1020)

    const shared = taskKey({ queue: 'close', cardId: 1121, pr: 1020, head: sha('a') })
    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'close' ORDER BY task_key`).all()).toEqual([{ task_key: close(1020) }, { task_key: shared }].sort((a, b) => a.task_key.localeCompare(b.task_key)))
    const outcomes = [bench.closeCard(bench.leaseClose()!), bench.closeCard(bench.leaseClose()!)]
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'closed', taskKey: close(1020), verification: 'run' }),
      expect.objectContaining({ kind: 'closed', taskKey: shared, verification: 'code-reading', cycle: expect.objectContaining({ cardFile: 'moved' }) }),
    ]))
    expect(bench.db.prepare(`SELECT card_id, pr FROM events WHERE type = '${CARD_CLOSED}' ORDER BY card_id`).all()).toEqual([{ card_id: 1120, pr: 1020 }, { card_id: 1121, pr: 1020 }])
    expect(launchCandidates(bench.db, () => false).map(candidate => candidate.cardId)).toContain(1123)
    expect(existsSync(parked)).toBe(false)
    expect(existsSync(path.join(bench.parking, 'archive', '1121.md'))).toBe(true)
    bench.close()
  })

  it('a card verified on another card\'s PR without --shared-by does not enter close', () => {
    const bench = closeBench()
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId: 1122, pr: 1021, head: null, dedupeKey: `${CARD_VERIFIED}:1122:1021`, payload: { path: 'cheap', pr: 1021, verification: 'run' }, legacy: false })
    bench.merged(1021, false)

    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'close'`).all()).toEqual([])
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

    expect(bench.closeCard(lease)).toEqual({ kind: 'closed', taskKey: close(993), verification: 'mutation', cycle: { mergeLine: 'written', cardFile: 'absent', treeLeft: null } })
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

  it('an alarm goes back to the queue once its cause is gone, at most D-104 attempts per cause', () => {
    const bench = closeBench()
    bench.merged(1018)
    const stoppedOnNoVerification = (): void => {
      for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
        expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'denied', denial: { reason: 'no_verification' } })
      bench.tick()
      expect(taskState(bench.db, close(1018)).state).toBe('stopped')
    }

    stoppedOnNoVerification()
    expect(eventsOf(bench.db, BOARD_ALARM)).toMatchObject([{ task_key: close(1018), reason: 'fault' }])
    for (const verification of ['code-reading', 'measurement', 'review']) {
      verified(bench, 1018, verification)
      bench.tick()
      expect(taskState(bench.db, close(1018)).state).toBe('queued')
      stoppedOnNoVerification()
    }
    verified(bench, 1018, 'mutation')
    bench.tick()

    expect(taskState(bench.db, close(1018)).state).toBe('stopped')
    expect(eventsOf(bench.db, TASK_REQUEUED)).toHaveLength(FAILURES_TO_STOP)
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([])
    bench.close()
  })

  it('an alarm on no_merge_commit goes back to the queue on a later merge.done or merged pr.closed, and an alarm on a cause with no clearing event stays stopped', () => {
    const clearing: Record<string, (bench: ReturnType<typeof closeBench>, pr: number) => void> = {
      [MERGE_DONE]: (bench, pr) => appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: MERGE_DONE, actor: 'worker:merge:worker-0', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `${MERGE_DONE}:${pr}`, payload: { commit: MAIN_2, rule: 'auto' }, legacy: false }),
      [PR_CLOSED]: (bench, pr) => appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: PR_CLOSED, actor: 'netwatch', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `${PR_CLOSED}:${pr}:again`, payload: { merged: 1, merge_commit: MAIN_2 }, legacy: false }),
      [CARD_VERIFIED]: (bench, pr) => verified(bench, pr, 'measurement'),
    }
    const cases: { cause: string, cleared: string, after: string }[] = [
      { cause: 'no_merge_commit', cleared: MERGE_DONE, after: 'queued' },
      { cause: 'no_merge_commit', cleared: PR_CLOSED, after: 'queued' },
      { cause: 'no_merge_commit', cleared: CARD_VERIFIED, after: 'stopped' },
      { cause: 'card_closed', cleared: MERGE_DONE, after: 'stopped' },
      { cause: 'card_closed', cleared: PR_CLOSED, after: 'stopped' },
      { cause: 'card_closed', cleared: CARD_VERIFIED, after: 'stopped' },
    ]
    for (const { cause, cleared, after } of cases) {
      const bench = closeBench()
      bench.merged(1018)
      const ts = bench.clock.now().toISOString()
      for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
        failTask(bench.db, ts, bench.leaseClose()!, { reason: cause, withdraw: false })
      bench.tick()
      expect(taskState(bench.db, close(1018)).state, `${cause} before ${cleared}`).toBe('stopped')
      clearing[cleared]!(bench, 1018)
      bench.tick()

      expect(taskState(bench.db, close(1018)).state, `${cause} after ${cleared}`).toBe(after)
      bench.close()
    }
  })

  it('an alarm stays stopped once its cause is gone while its pull request is closed, its head is old or its review rounds are spent', () => {
    const settings: Record<string, { after: string, before: (bench: ReturnType<typeof closeBench>) => void }> = {
      'an open pull request at the stopped head': { after: 'queued', before: () => {} },
      'a closed pull request': { after: 'withdrawn', before: bench => bench.gitHub.close(1019, false) },
      'an old head': { after: 'stopped', before: bench => bench.gitHub.open({ number: 1019, head: sha('b') }) },
      'spent review rounds': { after: 'stopped', before: bench => spendReviewRounds(bench, 1019, sha('a')) },
    }
    for (const [setting, { after, before }] of Object.entries(settings)) {
      const bench = closeBench()
      bench.gitHub.open({ number: 1019 })
      bench.tick()
      const ts = bench.clock.now().toISOString()
      const merge = taskKey({ queue: 'merge', cardId: 1119, pr: 1019, head: sha('a') })
      queueTask(bench.db, ts, { queue: 'merge', cardId: 1119, pr: 1019, head: sha('a') })
      for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
        failTask(bench.db, ts, leaseNext(bench.db, ts, 'merge', 'worker:merge:worker-1')!, { reason: 'no_verification', withdraw: false })
      bench.tick()
      expect(taskState(bench.db, merge).state, setting).toBe('stopped')
      before(bench)
      bench.tick()
      verified(bench, 1019)
      bench.tick()

      expect(taskState(bench.db, merge).state, setting).toBe(after)
      bench.close()
    }
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

  it('a merged card PR ends with the card in archive and a merge line in the journal, with no manual command', async () => {
    const bench = closeBench({ 1100: 'run' })
    const parked = bench.park(1100)
    bench.merged(1000)
    const calls = bench.gitHub.calls.length

    const worker = closeNode({ db: bench.db, reported: () => 'run', clock: bench.clock.now, session: 'cycle', journal: bench.journal, parking: bench.parking })
    expect(await step(worker)).toMatchObject({ kind: 'closed', verification: 'run', cycle: { mergeLine: 'written', cardFile: 'moved' } })
    expect(bench.gitHub.calls).toHaveLength(calls)
    expect(bench.gitHub.puts).toEqual([])
    expect(existsSync(parked)).toBe(false)
    expect(readFileSync(path.join(bench.parking, 'archive', '1100.md'), 'utf8')).toBe('card: #1100\n')
    const pullClosed = bench.db.prepare(`SELECT actor, ts FROM events WHERE type = 'pr.closed' AND pr = 1000`).get() as { actor: string, ts: string }
    expect(MERGER.login).not.toBe(pullClosed.actor)
    expect(MERGER.at).not.toBe(pullClosed.ts)
    expect(bench.mergeLines()).toEqual([{ event: 'merge', task: '1100', pr: 1000, by: MERGER.login, commit: MAIN_2, merged: MERGER.at, ts: bench.clock.now().toISOString() }])
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([{ verification: 'run' }])
    bench.close()
  })

  it('an empty lane disappears once its last card is closed', () => {
    const bench = closeBench({ 1105: 'run', 1106: 'run' })
    const lane = path.join(bench.parking, 'lane-01')
    bench.park(1105, 'lane-01')
    bench.park(1106, 'lane-01')
    bench.park(1107, 'lane-bus-1')
    writeLaneJson(lane, { purpose: 'p', touches: ['a.ts'], createdBy: 'owner', createdAt: '2026-10-11', status: 'open' })
    bench.merged(1005)
    bench.merged(1006)

    expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'closed', cycle: { cardFile: 'moved' } })
    expect(readdirSync(lane).sort()).toEqual(['1106.md', 'lane.json'])
    expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'closed', cycle: { cardFile: 'moved' } })
    expect(existsSync(lane)).toBe(false)
    expect(readdirSync(path.join(bench.parking, 'archive')).sort()).toEqual(['1105.md', '1106.md'])
    expect(readdirSync(path.join(bench.parking, 'lane-bus-1'))).toEqual(['1107.md'])
    bench.close()
  })

  it('a directory without lane.json stays when its last card is closed', () => {
    const bench = closeBench({ 1108: 'run' })
    bench.park(1108, 'lane-bus-2')
    bench.merged(1008)

    expect(bench.closeCard(bench.leaseClose()!)).toMatchObject({ kind: 'closed', cycle: { cardFile: 'moved' } })
    expect(readdirSync(path.join(bench.parking, 'lane-bus-2'))).toEqual([])
    bench.close()
  })

  it('a merged PR with no recorded merger gets no merge line from close and is still archived', () => {
    const bench = closeBench({ 1103: 'run' })
    const parked = bench.park(1103)
    bench.gitHub.open({ number: 1003 })
    bench.tick()
    verified(bench, 1003)
    bench.gitHub.close(1003, true, null)
    bench.tick()
    detectClose(bench.db, bench.clock.now)
    const calls = bench.gitHub.calls.length

    expect(bench.closeCard(bench.leaseClose()!)).toEqual({ kind: 'closed', taskKey: close(1003), verification: 'run', cycle: { mergeLine: 'no-merger', cardFile: 'moved', treeLeft: null } })
    expect(bench.gitHub.calls).toHaveLength(calls)
    expect(bench.mergeLines()).toEqual([])
    expect(existsSync(parked)).toBe(false)
    expect(existsSync(path.join(bench.parking, 'archive', '1103.md'))).toBe(true)
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([{ verification: 'run' }])
    bench.close()
  })

  it('the close executor writes no merge line after the cutoff', () => {
    const bench = closeBench({ 1104: 'run' })
    const parked = bench.park(1104)
    bench.clock.ms = AFTER_HISTORY.getTime()
    bench.merged(1004)

    expect(bench.closeCard(bench.leaseClose()!)).toEqual({ kind: 'closed', taskKey: close(1004), verification: 'run', cycle: { mergeLine: 'in-bus', cardFile: 'moved', treeLeft: null } })
    expect(existsSync(bench.journal)).toBe(false)
    expect(existsSync(parked)).toBe(false)
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

  it('card.closed takes the verification from card.verified after the cutoff', async () => {
    const bench = closeBench()
    mkdirSync(path.dirname(bench.journal), { recursive: true })
    writeFileSync(bench.journal, `${windowStartLine(1114)}\n`)
    const closing = runTaskClose(['1114', '--pr', '1014', '--verification', 'code-reading'], { ...taskCloseDeps(path.dirname(bench.journal), AFTER_HISTORY), busPath: bench.busPath })
    expect(closing.exitCode).toBe(0)
    expect(readFileSync(bench.journal, 'utf8')).toBe(`${windowStartLine(1114)}\n`)
    bench.merged(1014, false)
    reviewed(bench, 1014, sha('a'), 'pass')

    const worker = closeNode({ db: bench.db, reported: closingVerification(bench.busPath), clock: bench.clock.now, session: 'window', journal: bench.journal, parking: bench.parking })
    expect(await step(worker)).toMatchObject({ kind: 'closed', taskKey: close(1014), verification: 'code-reading' })
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([{ verification: 'code-reading' }])
    expect(reduce(bench.db).rejected).toBe(0)
    bench.close()
  })

  it('card.closed reads the card.verified of its own card and PR, never another card\'s, another PR\'s or a legacy one', async () => {
    const bench = closeBench()
    mkdirSync(path.dirname(bench.journal), { recursive: true })
    writeFileSync(bench.journal, `${windowStartLine(1116)}\n`)
    const closing = runTaskClose(['1116', '--pr', '1016', '--verification', 'code-reading'], { ...taskCloseDeps(path.dirname(bench.journal), AFTER_HISTORY), busPath: bench.busPath })
    expect(closing.exitCode).toBe(0)
    const decoy = (cardId: number, pr: number, verification: string, legacy: boolean): void => {
      appendEvent(bench.db, { ts: AFTER_HISTORY.toISOString(), type: CARD_VERIFIED, actor: 'worker:task-close:decoy', cardId, pr, head: null, dedupeKey: `${CARD_VERIFIED}:decoy:${cardId}:${pr}:${verification}`, payload: { path: 'cheap', pr, verification }, legacy })
    }
    decoy(1199, 1016, 'browser', false)
    decoy(1116, 1099, 'measurement', false)
    decoy(1116, 1016, 'mutation', true)
    bench.merged(1016, false)
    reviewed(bench, 1016, sha('a'), 'pass')

    const worker = closeNode({ db: bench.db, reported: closingVerification(bench.busPath), clock: bench.clock.now, session: 'window', journal: bench.journal, parking: bench.parking })
    expect(await step(worker)).toMatchObject({ kind: 'closed', taskKey: close(1016), verification: 'code-reading' })
    bench.close()
  })

  it('gets the closing check of a PR from before the cutoff with an empty journal', () => {
    const bench = closeBench()
    appendEvent(bench.db, legacyEventOf(JSON.stringify({ event: 'path', task: '1117', path: 'cheap', pr: 1017, verification: 'code-reading', ts: '2026-10-11T18:00:00.000Z' }), 1)!)
    const reported = closingVerification(bench.busPath)
    expect(existsSync(bench.journal)).toBe(false)
    expect(reported(1117, 1017)).toBe('code-reading')
    expect(reported(1117, 1099)).toBeNull()
    bench.close()
  })

  it('a journal path line written after the cutoff is not read for card.closed', async () => {
    const bench = closeBench()
    mkdirSync(path.dirname(bench.journal), { recursive: true })
    writeFileSync(bench.journal, `${windowStartLine(1115)}\n${JSON.stringify({ event: 'path', task: '1115', path: 'cheap', pr: 1015, verification: 'code-reading', ts: AFTER_HISTORY.toISOString() })}\n`)
    bench.merged(1015, false)
    reviewed(bench, 1015, sha('a'), 'pass')

    const worker = closeNode({ db: bench.db, reported: closingVerification(bench.busPath), clock: bench.clock.now, session: 'window', journal: bench.journal, parking: bench.parking })
    expect(await step(worker)).toEqual({ kind: 'idle' })
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([])
    bench.close()
  })

  it('a review pass at the merged head closes nothing without card.verified', () => {
    const bench = closeBench()
    bench.merged(1011, false)
    reviewed(bench, 1011, sha('a'), 'pass')
    bench.tick()

    expect(bench.leaseClose()).toBeNull()
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([])
    bench.close()
  })

  it('a shift report, a journal line of another PR and a review pass bring no card into close without card.verified', async () => {
    const shiftRoot = path.join(tmpdir(), 'absent-shift')
    const bench = closeBench()
    mkdirSync(path.join(shiftRoot, 'lane-1'), { recursive: true })
    writeFileSync(path.join(shiftRoot, 'lane-1', 'report-1113.md'), '#1113 card\nverification: run\n')
    mkdirSync(path.dirname(bench.journal), { recursive: true })
    writeFileSync(bench.journal, `${windowStartLine(1112)}\n${JSON.stringify({ event: 'path', task: '1112', path: 'cheap', pr: 999, verification: 'run' })}\n`)
    bench.merged(1012, false)
    reviewed(bench, 1012, sha('a'), 'changes')
    reviewed(bench, 1012, sha('b'), 'pass')

    const worker = closeNode({ db: bench.db, reported: closingVerification(bench.busPath), clock: bench.clock.now, session: 'none', journal: bench.journal, parking: bench.parking })
    expect(await step(worker)).toEqual({ kind: 'idle' })
    expect(eventsOf(bench.db, CARD_CLOSED)).toEqual([])
    bench.close()
  })

  it('the close worker is switched off without --on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await runCloseWorker([], { busPath: '/nonexistent/bus.db', reported: () => null, session: 's', journal: '/nonexistent/ghosts.jsonl', parking: '/nonexistent/parking', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
  })
})
