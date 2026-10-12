import type { BusEvent } from '../../bus/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { cardIdOfDescription } from '../../bus/identifiers.js'
import { reduce } from '../../bus/reducer.js'
import { REJECTED } from '../../bus/rejection.js'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const NEXT_HEAD = '89abcdef0123456789abcdef0123456789abcdef'
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98'
const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): ReturnType<typeof openBus> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-reducer-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function event(type: string, fields: Partial<BusEvent>): BusEvent {
  sequence += 1
  return {
    ts: '2026-10-09T12:00:00.000Z',
    type,
    actor: 'netwatch',
    cardId: null,
    pr: null,
    head: null,
    dedupeKey: `${type}:${sequence}`,
    payload: {},
    legacy: false,
    ...fields,
  }
}

function observed(pr: number, cardId: number | null, overrides: Record<string, unknown> = {}): BusEvent {
  const payload = { base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, ...overrides }
  return event('pr.observed', { pr, cardId, head: payload.head as string, payload })
}

function closed(pr: number, merged: boolean): BusEvent {
  return event('pr.closed', { pr, payload: merged ? { merged, commit: MAIN } : { merged } })
}

function opened(cardId: number, pr: number): BusEvent {
  return event('pr.opened', { actor: 'worker:launch:s1', cardId, payload: { pr } })
}

function admitted(cardId: number): BusEvent {
  return event('card.admitted', { actor: 'reducer', cardId, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [] } })
}

function started(cardId: number): BusEvent {
  return event('card.started', { actor: 'worker:launch:s1', cardId, payload: { session: 's1' } })
}

function busWith(...events: BusEvent[]): ReturnType<typeof openBus> {
  const db = newBus()
  for (const each of events)
    appendEvent(db, each)
  return db
}

function prs(db: ReturnType<typeof openBus>): Record<string, unknown>[] {
  return db.prepare('SELECT pr, card_id, head, state, mergeable, ci FROM prs ORDER BY pr').all() as Record<string, unknown>[]
}

function cards(db: ReturnType<typeof openBus>): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM cards ORDER BY card_id').all() as Record<string, unknown>[]
}

function rejections(db: ReturnType<typeof openBus>): Record<string, unknown>[] {
  return (db.prepare('SELECT actor, card_id, pr, payload FROM events WHERE type = ? ORDER BY id').all(REJECTED) as Record<string, unknown>[])
    .map(row => ({ ...row, payload: JSON.parse(row.payload as string) as unknown }))
}

describe('the reducer of the prs projection', () => {
  it('pr.observed writes the pr as open with the observed fields', () => {
    const db = busWith(observed(800, 793))
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    expect(prs(db)).toEqual([{ pr: 800, card_id: 793, head: HEAD, state: 'open', mergeable: 'clean', ci: 'green' }])
    db.close()
  })

  it('a later pr.observed with a new head replaces the earlier reading', () => {
    const db = busWith(observed(800, 793), observed(800, null, { head: NEXT_HEAD, ci: 'pending' }))
    reduce(db)
    expect(prs(db)).toEqual([{ pr: 800, card_id: 793, head: NEXT_HEAD, state: 'open', mergeable: 'clean', ci: 'pending' }])
    db.close()
  })

  it('pr.closed with merged moves the pr projection to merged', () => {
    const db = busWith(observed(800, 793), closed(800, true))
    expect(reduce(db)).toEqual({ applied: 2, rejected: 0 })
    expect(prs(db)).toEqual([{ pr: 800, card_id: 793, head: HEAD, state: 'merged', mergeable: 'clean', ci: 'green' }])
    db.close()
  })

  it('pr.closed without merged moves the pr to closed, and a later observation reopens it', () => {
    const db = busWith(observed(800, 793), closed(800, false))
    reduce(db)
    expect(prs(db)[0]?.state).toBe('closed')
    appendEvent(db, observed(800, 793, { head: NEXT_HEAD }))
    reduce(db)
    expect(prs(db)[0]?.state).toBe('open')
    db.close()
  })

  it('main.advanced keeps the mergeable reading of every open pr until a new observation replaces it', () => {
    const db = busWith(observed(800, 793, { mergeable: 'behind' }), observed(801, 794, { base: 'release' }), observed(802, 795), closed(802, true))
    appendEvent(db, event('main.advanced', { payload: { sha: MAIN, touches_mechanics: false } }))
    reduce(db)
    expect(prs(db).map(row => [row.pr, row.state, row.mergeable])).toEqual([[800, 'open', 'behind'], [801, 'open', 'clean'], [802, 'merged', 'clean']])
    db.close()
  })

  it('rejects an invalid pr event with reducer.rejected and leaves the projection as it was', () => {
    const db = busWith(
      observed(800, 793),
      closed(801, true),
      observed(800, 793, { mergeable: 'maybe' }),
      closed(800, true),
      observed(800, 793, { head: NEXT_HEAD }),
      event('main.advanced', { payload: { sha: 'abc', touches_mechanics: false } }),
    )
    expect(reduce(db)).toEqual({ applied: 2, rejected: 4 })
    expect(prs(db)).toEqual([{ pr: 800, card_id: 793, head: HEAD, state: 'merged', mergeable: 'clean', ci: 'green' }])
    expect(rejections(db).map(row => (row.payload as { reason: string }).reason)).toEqual([
      'pr 801 was never observed',
      'mergeable is not one of clean | behind | dirty | blocked',
      'pr 800 is merged',
      'sha is not a full sha',
    ])
    expect(rejections(db).every(row => row.actor === 'reducer')).toBe(true)
    db.close()
  })

  it('reducing again rebuilds the same projections and records no rejection twice', () => {
    const db = busWith(observed(800, 793), closed(801, true), closed(800, true))
    reduce(db)
    const first = { prs: prs(db), cards: cards(db) }
    expect(reduce(db)).toEqual({ applied: 2, rejected: 1 })
    expect({ prs: prs(db), cards: cards(db) }).toEqual(first)
    expect(rejections(db)).toHaveLength(1)
    db.close()
  })

  it('ignores legacy events and event types no fold reads', () => {
    const db = busWith(
      { ...observed(800, 793), actor: null, legacy: true },
      event('card.moved', { actor: 'worker:launch:s1', cardId: 793, payload: { from: 'lane-1', to: 'lane-2' } }),
    )
    expect(reduce(db)).toEqual({ applied: 0, rejected: 0 })
    expect(prs(db)).toEqual([])
    expect(cards(db)).toEqual([])
    db.close()
  })
})

describe('the card automaton', () => {
  it('the cards projection links each card to its pr', () => {
    const db = busWith(
      opened(793, 800),
      observed(800, 793),
      event('card.started', { actor: 'worker:launch:s1', cardId: 793, payload: { session: 's1' } }),
      observed(801, 794),
      closed(801, true),
    )
    reduce(db)
    expect(cards(db)).toEqual([
      { card_id: 793, state: 'in_review', pr: 800, event_id: 1 },
      { card_id: 794, state: 'merged', pr: 801, event_id: 5 },
    ])
    db.close()
  })

  it('an invalid card transition writes reducer.rejected and leaves the card unchanged', () => {
    const db = busWith(observed(800, 793), opened(793, 805), observed(806, 793, { head: NEXT_HEAD }), started(793), event('card.closed', { actor: 'worker:close:s1', cardId: 793, payload: { verification: 'run' } }))
    reduce(db)
    expect(cards(db)).toEqual([{ card_id: 793, state: 'in_review', pr: 800, event_id: 1 }])
    expect(prs(db).map(row => row.pr)).toEqual([800])
    expect(rejections(db)).toEqual([
      { actor: 'reducer', card_id: 793, pr: null, payload: { event_id: 2, type: 'pr.opened', reason: 'card 793 is linked to pr 800, which is still open' } },
      { actor: 'reducer', card_id: 793, pr: 806, payload: { event_id: 3, type: 'pr.observed', reason: 'card 793 is linked to pr 800, which is still open' } },
      { actor: 'reducer', card_id: 793, pr: null, payload: { event_id: 4, type: 'card.started', reason: 'card 793 is in_review, and card.started moves only a card that is queued' } },
      { actor: 'reducer', card_id: 793, pr: null, payload: { event_id: 5, type: 'card.closed', reason: 'card 793 is in_review and its pull request is not merged, and card.closed closes only a merged card' } },
    ])
    db.close()
  })

  it('a card whose pr closed unmerged links to its next pr, and a card whose pr merged does not', () => {
    const db = busWith(observed(800, 793), closed(800, false), opened(793, 805), observed(810, 794), closed(810, true), opened(794, 811))
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.pr])).toEqual([[793, 805], [794, 810]])
    expect(rejections(db).map(row => (row.payload as { reason: string }).reason)).toEqual(['card 794 is linked to pr 810, which is merged'])
    db.close()
  })

  it('a pr observed under one card is not claimed by another', () => {
    const db = busWith(observed(800, 793), observed(800, 794, { ci: 'red' }))
    reduce(db)
    expect(prs(db)).toEqual([{ pr: 800, card_id: 793, head: HEAD, state: 'open', mergeable: 'clean', ci: 'green' }])
    expect(cards(db).map(row => row.card_id)).toEqual([793])
    expect(rejections(db).map(row => (row.payload as { reason: string }).reason)).toEqual(['pr 800 belongs to card 793, not 794'])
    db.close()
  })

  it('a pull request is linked to its card whether body line 1 carries the card prefix or only the number', () => {
    const db = busWith(
      observed(753, cardIdOfDescription('card: #764 lane-guard [implement/bus/S/cheap/auto]\nbranch: feat/x')),
      observed(754, cardIdOfDescription('#765 lane-guard [implement/bus/S/cheap/auto]')),
    )
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.pr])).toEqual([[764, 753], [765, 754]])
    expect(prs(db).map(row => [row.pr, row.card_id])).toEqual([[753, 764], [754, 765]])
    db.close()
  })

  it('card.admitted queues a card, card.started runs it and pr.opened puts it in review', () => {
    const db = busWith(admitted(793))
    const states: unknown[] = []
    for (const next of [started(793), opened(793, 800)]) {
      reduce(db)
      states.push(cards(db)[0]?.state)
      appendEvent(db, next)
    }
    reduce(db)
    states.push(cards(db)[0]?.state)
    expect(states).toEqual(['queued', 'running', 'in_review'])
    expect(rejections(db)).toEqual([])
    db.close()
  })

  it('review, merge and close move the card on from review, and a fall or a stop comes back through admission and answer', () => {
    const review = (verdict: string): BusEvent => event('review.recorded', { actor: 'worker:review:r1', cardId: 793, pr: 800, head: HEAD, payload: { head: HEAD, verdict, reviewer_session: 'r1' } })
    const steps: [BusEvent, string][] = [
      [admitted(793), 'queued'],
      [started(793), 'running'],
      [event('card.fell', { actor: 'worker:launch:s1', cardId: 793, payload: { kind: 'session' } }), 'fallen'],
      [admitted(793), 'queued'],
      [started(793), 'running'],
      [opened(793, 800), 'in_review'],
      [observed(800, null), 'in_review'],
      [review('changes'), 'changes'],
      [event('card.stopped', { actor: 'worker:answer:a1', cardId: 793, payload: { reason: 'review', detail: 'x' } }), 'stopped'],
      [event('card.answered', { actor: 'worker:answer:a1', cardId: 793, payload: { session: 'a1' } }), 'in_review'],
      [review('pass'), 'ready'],
      [event('merge.done', { actor: 'worker:merge:m1', cardId: 793, pr: 800, head: HEAD, payload: { commit: MAIN, rule: 'auto' } }), 'merged'],
      [closed(800, true), 'merged'],
      [event('card.closed', { actor: 'worker:close:c1', cardId: 793, payload: { verification: 'run' } }), 'closed'],
    ]
    const db = newBus()
    const states = steps.map(([next]) => {
      appendEvent(db, next)
      reduce(db)
      return cards(db)[0]?.state
    })
    expect(states).toEqual(steps.map(([, state]) => state))
    expect(rejections(db)).toEqual([])
    db.close()
  })

  it('a pull request netwatch links never leaves its card state null', () => {
    const db = busWith(observed(800, 793), observed(801, 794), closed(801, true), observed(802, cardIdOfDescription('#795 x [implement/bus/S/cheap/auto]')))
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[793, 'in_review'], [794, 'merged'], [795, 'in_review']])
    expect(db.prepare('SELECT count(*) AS n FROM cards WHERE state IS NULL').get()).toEqual({ n: 0 })
    db.close()
  })

  it('pr.opened from a worker links card and pull request without parsing the body', () => {
    const db = busWith(opened(793, 800), observed(800, null))
    expect(reduce(db)).toEqual({ applied: 2, rejected: 0 })
    expect(cards(db)).toEqual([{ card_id: 793, state: 'in_review', pr: 800, event_id: 1 }])
    expect(prs(db)).toEqual([{ pr: 800, card_id: 793, head: HEAD, state: 'open', mergeable: 'clean', ci: 'green' }])
    db.close()
  })

  it('an imported admission of a card merged before the cutover leaves it merged, and of a card never merged queues it', () => {
    const legacyMerge = event('merge', { actor: null as unknown as string, cardId: 795, dedupeKey: 'legacy:1:merge', payload: { event: 'merge', task: '795', by: 'owner' }, legacy: true })
    const imported = (cardId: number): BusEvent => event('card.admitted', { actor: 'reducer', cardId, payload: { lane: 'archive', depends: [], admission: `legacy:${cardId}:sha` } })
    const db = busWith(legacyMerge, imported(795), imported(796))
    expect(reduce(db)).toEqual({ applied: 2, rejected: 0 })
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[795, 'merged'], [796, 'queued']])
    db.close()
  })

  it('facts imported after the card moved on are folded without a rejection', () => {
    const db = busWith(observed(800, 793), closed(800, true), event('card.closed', { actor: 'worker:close:c1', cardId: 793, payload: { verification: 'run' } }), admitted(793), event('review.recorded', { actor: 'worker:review:r1', cardId: 794, payload: { verdict: 'pass' } }))
    expect(reduce(db)).toEqual({ applied: 5, rejected: 0 })
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[793, 'queued']])
    db.close()
  })
})
