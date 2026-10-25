import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, PR_OPENED, REJECTED } from '../../core/events.js'
import { failTask, leaseNext } from '../../core/lease.js'
import { FAILURES_TO_STOP } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
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
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: `lane-${cardId}`, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
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
