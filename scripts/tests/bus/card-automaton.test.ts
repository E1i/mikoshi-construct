import type { Lease } from '../../core/lease.js'
import type { CardStarter } from '../../nodes/launch/launch-executor.js'
import type { DiskReader } from '../../ports/disk.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, PR_OPENED, REJECTED, TASK_REQUEUED, TASK_SUPERSEDED } from '../../core/events.js'
import { failTask, leaseNext } from '../../core/lease.js'
import { FAILURES_TO_STOP } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { LaunchExecutor } from '../../nodes/launch/launch-executor.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { mergeBench } from './merge-bench.js'

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function stateOf(made: MergeBench, cardId: number): string | null {
  return (made.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined)?.state ?? null
}

function stoppedByFault(made: MergeBench, cardId: number): number {
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: `lane-card-${cardId}`, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  let leaseGen = 0
  for (let failure = 0; failure < FAILURES_TO_STOP; failure += 1) {
    const lease = leaseNext(made.db, ts(), 'launch', 'worker:launch:worker-1')!
    leaseGen = lease.leaseGen
    failTask(made.db, ts(), lease, { reason: 'start_failed', withdraw: false })
  }
  reduce(made.db)
  expect(stateOf(made, cardId)).toBe('stopped')
  return leaseGen
}

function startedUnder(made: MergeBench, cardId: number, leaseGen: number): string {
  const dedupeKey = `${CARD_STARTED}:restored-${cardId}-${leaseGen}`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:worker-1', cardId, pr: null, head: null, dedupeKey, payload: { session: `s-${cardId}`, lease_gen: leaseGen }, legacy: false })
  return dedupeKey
}

function openedUnder(made: MergeBench, cardId: number, pr: number, leaseGen: number): string {
  const dedupeKey = `${PR_OPENED}:${cardId}:${pr}`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId, pr, head: null, dedupeKey, payload: { pr, lease_gen: leaseGen }, legacy: false })
  return dedupeKey
}

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roomy: DiskReader = () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES })

const sessionStarter: CardStarter = {
  start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }),
  stop: () => {},
}

function launchedUnder(made: MergeBench, actor: string): Lease {
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'launch', actor)!
  const executor = new LaunchExecutor({ db: made.db, starter: sessionStarter, clock: made.clock.now, disk: roomy, isolation: sandboxed })
  const outcome = executor.launch(lease)
  expect(outcome.kind === 'denied' ? outcome.denial : outcome.kind).toBe('started')
  reduce(made.db)
  return lease
}

function requeuedAfterFaultStop(made: MergeBench, cardId: number): Lease {
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: `lane-card-${cardId}`, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const first = launchedUnder(made, 'worker:launch:worker-1')
  expect(stateOf(made, cardId)).toBe('running')
  appendEvent(made.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:shift:1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:fault-${cardId}`, payload: { reason: 'fault', detail: 'the session died' }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: TASK_SUPERSEDED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${TASK_SUPERSEDED}:${first.taskKey}`, payload: { task_key: first.taskKey, queue: 'launch', generation: `admission-${cardId}` }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: TASK_REQUEUED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${TASK_REQUEUED}:${first.taskKey}:request-1`, payload: { task_key: first.taskKey, queue: 'launch', generation: `admission-${cardId}`, request: 1 }, legacy: false })
  reduce(made.db)
  expect(stateOf(made, cardId)).toBe('stopped')
  const second = launchedUnder(made, 'worker:launch:worker-2')
  expect(second.taskKey).toBe(first.taskKey)
  expect(second.leaseGen).toBe(first.leaseGen + 1)
  return second
}

function startsOf(made: MergeBench, cardId: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${CARD_STARTED}' AND card_id = ?`).get(cardId) as { n: number }).n)
}

function rejected(made: MergeBench, dedupeKey: string): boolean {
  return made.db.prepare('SELECT 1 FROM events WHERE dedupe_key = ?').get(`${REJECTED}:${dedupeKey}`) !== undefined
}

function stoppedByQuestion(made: MergeBench, cardId: number): void {
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: `lane-${cardId}`, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:shift:1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: 'question.owner', detail: 'which pull request' }, legacy: false })
  reduce(made.db)
  expect(stateOf(made, cardId)).toBe('stopped')
}

function mergedPr(made: MergeBench, pr: number): void {
  made.gitHub.open({ number: pr })
  made.tick()
  made.gitHub.close(pr, true)
  made.tick()
}

function verifiedOn(made: MergeBench, cardId: number, pr: number, shared: Record<string, string>): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId, pr, head: null, dedupeKey: `${CARD_VERIFIED}:${cardId}:${pr}`, payload: { path: 'cheap', pr, verification: 'run', ...shared }, legacy: false })
}

function closedOn(made: MergeBench, cardId: number, pr: number): string {
  const dedupeKey = `${CARD_CLOSED}:${cardId}`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:worker-1', cardId, pr, head: null, dedupeKey, payload: { verification: 'run' }, legacy: false })
  reduce(made.db)
  return dedupeKey
}

describe('a shared close', () => {
  it('a stopped card with a recorded decision is closed by a shared close', () => {
    const made = bench()
    stoppedByQuestion(made, 1301)
    mergedPr(made, 9301)
    verifiedOn(made, 1301, 9301, { sharedBy: 'D-189' })
    const closed = closedOn(made, 1301, 9301)

    expect(stateOf(made, 1301)).toBe('closed')
    expect(rejected(made, closed)).toBe(false)
  })

  it('a shared close without a recorded decision is refused', () => {
    const made = bench()
    stoppedByQuestion(made, 1302)
    mergedPr(made, 9302)
    verifiedOn(made, 1302, 9302, {})
    const closed = closedOn(made, 1302, 9302)

    expect(stateOf(made, 1302)).toBe('stopped')
    expect(rejected(made, closed)).toBe(true)
  })

  it('a decision on a pull request that is not merged closes no stopped card', () => {
    const made = bench()
    stoppedByQuestion(made, 1303)
    made.gitHub.open({ number: 9303 })
    made.tick()
    verifiedOn(made, 1303, 9303, { sharedBy: 'D-189' })
    const closed = closedOn(made, 1303, 9303)

    expect(stateOf(made, 1303)).toBe('stopped')
    expect(rejected(made, closed)).toBe(true)
  })
})

describe('a card never admitted', () => {
  it('a card never admitted is dropped', () => {
    const made = bench()
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_DROPPED, actor: 'worker:intake:s1', cardId: 1304, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:1304`, payload: { lane: 'dropped' }, legacy: false })
    reduce(made.db)

    expect(stateOf(made, 1304)).toBe('dropped')
    expect(made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = 1304`).get()).toEqual({ n: 0 })
  })
})

describe('a card stopped by fault', () => {
  it('pr.opened or card.started with the current lease_gen restore a card stopped by fault', () => {
    const made = bench()
    const started = startedUnder(made, 1201, stoppedByFault(made, 1201))
    const opened = openedUnder(made, 1202, 9202, stoppedByFault(made, 1202))
    reduce(made.db)

    expect(stateOf(made, 1201)).toBe('running')
    expect(stateOf(made, 1202)).toBe('in_review')
    expect(rejected(made, started)).toBe(false)
    expect(rejected(made, opened)).toBe(false)
  })

  it('pr.opened or card.started with an older lease_gen is reducer.rejected', () => {
    const made = bench()
    const started = startedUnder(made, 1203, stoppedByFault(made, 1203) - 1)
    const opened = openedUnder(made, 1204, 9204, stoppedByFault(made, 1204) - 1)
    reduce(made.db)

    expect(stateOf(made, 1203)).toBe('stopped')
    expect(stateOf(made, 1204)).toBe('stopped')
    expect(rejected(made, started)).toBe(true)
    expect(rejected(made, opened)).toBe(true)
  })

  it('a card.started that carries no lease restores no card stopped by fault', () => {
    const made = bench()
    stoppedByFault(made, 1205)
    const dedupeKey = `${CARD_STARTED}:earlier-1205`
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: 1205, pr: null, head: null, dedupeKey, payload: { session: 'earlier' }, legacy: false })
    reduce(made.db)

    expect(stateOf(made, 1205)).toBe('stopped')
    expect(rejected(made, dedupeKey)).toBe(true)
  })

  it('a launch requeued after a fault stop records its start and the card leaves stopped', () => {
    const made = bench()
    requeuedAfterFaultStop(made, 1207)

    expect(startsOf(made, 1207)).toBe(2)
    expect(stateOf(made, 1207)).toBe('running')
  })

  it('a pull request opened after a requeued start links to the card', () => {
    const made = bench()
    requeuedAfterFaultStop(made, 1208)
    const opened = `${PR_OPENED}:1208:9208`
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: 1208, pr: 9208, head: null, dedupeKey: opened, payload: { pr: 9208 }, legacy: false })
    reduce(made.db)

    expect(rejected(made, opened)).toBe(false)
    expect(stateOf(made, 1208)).toBe('in_review')
    expect(made.db.prepare('SELECT pr FROM cards WHERE card_id = ?').get(1208)).toEqual({ pr: 9208 })
  })

  it('a pull request opened under an older lease of a card stopped by fault is still rejected', () => {
    const made = bench()
    const lease = requeuedAfterFaultStop(made, 1209)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:shift:1', cardId: 1209, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:fault-again-1209`, payload: { reason: 'fault', detail: 'the session died again' }, legacy: false })
    reduce(made.db)
    const opened = openedUnder(made, 1209, 9209, lease.leaseGen - 1)
    reduce(made.db)

    expect(rejected(made, opened)).toBe(true)
    expect(stateOf(made, 1209)).toBe('stopped')
  })

  it('a card stopped by question is not restored by a card.started under the current lease_gen', () => {
    const made = bench()
    const leaseGen = stoppedByFault(made, 1206)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:shift:1', cardId: 1206, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:question-1206`, payload: { reason: 'question.owner', detail: 'which lane' }, legacy: false })
    const started = startedUnder(made, 1206, leaseGen)
    reduce(made.db)

    expect(stateOf(made, 1206)).toBe('stopped')
    expect(rejected(made, started)).toBe(true)
  })
})
