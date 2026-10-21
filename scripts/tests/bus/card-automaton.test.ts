import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { failTask, leaseNext } from '../../bus/lease.js'
import { FAILURES_TO_STOP } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, PR_OPENED, REJECTED } from '../../core/events.js'
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
