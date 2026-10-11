import type { BusEvent } from '../../bus/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { reduce, REJECTED } from '../../bus/reducer.js'

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

  it('ignores legacy events and event types outside slice 1', () => {
    const db = busWith(
      { ...observed(800, 793), actor: null, legacy: true },
      event('card.started', { actor: 'worker:launch:s1', cardId: 793, payload: { session: 's1' } }),
    )
    expect(reduce(db)).toEqual({ applied: 0, rejected: 0 })
    expect(prs(db)).toEqual([])
    expect(cards(db)).toEqual([])
    db.close()
  })
})

describe('the minimal cards projection', () => {
  it('the cards projection holds only the card to pr link', () => {
    const db = busWith(
      opened(793, 800),
      observed(800, 793),
      event('card.started', { actor: 'worker:launch:s1', cardId: 793, payload: { session: 's1' } }),
      observed(801, 794),
      closed(801, true),
    )
    reduce(db)
    expect(cards(db)).toEqual([
      { card_id: 793, state: null, pr: 800, event_id: 1 },
      { card_id: 794, state: null, pr: 801, event_id: 4 },
    ])
    db.close()
  })

  it('an invalid card transition writes reducer.rejected and leaves the card unchanged', () => {
    const db = busWith(observed(800, 793), opened(793, 805), observed(806, 793, { head: NEXT_HEAD }))
    reduce(db)
    expect(cards(db)).toEqual([{ card_id: 793, state: null, pr: 800, event_id: 1 }])
    expect(prs(db).map(row => row.pr)).toEqual([800])
    expect(rejections(db)).toEqual([
      { actor: 'reducer', card_id: 793, pr: null, payload: { event_id: 2, type: 'pr.opened', reason: 'card 793 is linked to pr 800, which is still open' } },
      { actor: 'reducer', card_id: 793, pr: 806, payload: { event_id: 3, type: 'pr.observed', reason: 'card 793 is linked to pr 800, which is still open' } },
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
})
