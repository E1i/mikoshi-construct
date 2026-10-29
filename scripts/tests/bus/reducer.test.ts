import type { BusEvent } from '../../core/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendedOnCard } from '../../core/card-automaton.js'
import { appendEvent, BUS_DB_VARIABLE, openBus, openBusWait, openOwnerWait } from '../../core/db.js'
import { CARD_WAITING, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, REJECTED, WITNESS_DOWNGRADE } from '../../core/events.js'
import { cardIdOfDescription } from '../../core/identifiers.js'
import { ghostLines } from '../../core/journal.js'
import { reentryLimitWaitText } from '../../core/queue.js'
import { DIRTY_ROWS, projectionDump, reduce, REDUCE_BATCH, reducedThrough, SNAPSHOT } from '../../core/reducer.js'
import { WATERMARKS } from '../../core/watermark.js'
import { recordFall } from '../../ladder/supervise.js'
import { recordDecision } from '../../policy/decisions.js'
import { allowLiveCommand } from '../../policy/live-decision.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'

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

  it('reducing again folds nothing new, a rebuild gives the same projections, and no rejection is recorded twice', () => {
    const db = busWith(observed(800, 793), closed(801, true), closed(800, true))
    reduce(db)
    const first = { prs: prs(db), cards: cards(db) }
    expect(reduce(db)).toEqual({ applied: 0, rejected: 0 })
    expect({ prs: prs(db), cards: cards(db) }).toEqual(first)
    expect(reduce(db, 'rebuild')).toEqual({ applied: 2, rejected: 1 })
    expect({ prs: prs(db), cards: cards(db) }).toEqual(first)
    expect(rejections(db)).toHaveLength(1)
    db.close()
  })

  it('events past one batch fold in batches to the projections a rebuild gives, and a later reduce folds only the new ones', () => {
    const pulls = REDUCE_BATCH
    const db = busWith(observed(800, 793))
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    for (let n = 0; n < pulls; n += 1) {
      appendEvent(db, observed(1000 + n, null))
      appendEvent(db, closed(1000 + n, n % 2 === 0))
    }
    expect(reduce(db)).toEqual({ applied: 2 * pulls, rejected: 0 })
    expect(reducedThrough(db)).toBe(2 * pulls + 1)
    const batched = projectionDump(db)
    appendEvent(db, closed(800, true))
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    const incremental = projectionDump(db)
    expect(incremental).not.toBe(batched)
    reduce(db, 'rebuild')
    expect(projectionDump(db)).toBe(incremental)
    db.close()
  })

  it('a bus reduced before the snapshot existed builds it within one reduce, one batch per write transaction beside the live projections, to what a rebuild gives', () => {
    const pulls = REDUCE_BATCH
    const db = busWith(observed(800, 793))
    for (let n = 0; n < pulls; n += 1) {
      appendEvent(db, observed(1000 + n, null))
      appendEvent(db, closed(1000 + n, true))
    }
    reduce(db, 'rebuild')
    db.prepare(`DELETE FROM ${WATERMARKS} WHERE projection = ?`).run(SNAPSHOT)
    appendEvent(db, closed(800, true))
    const exec = vi.spyOn(db, 'exec')

    expect(reduce(db)).toEqual({ applied: 2 * pulls + 2, rejected: 0 })
    const writes = exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE').length
    exec.mockRestore()
    expect(writes).toBeGreaterThan(Math.ceil((2 * pulls + 2) / REDUCE_BATCH))
    expect(reducedThrough(db)).toBe(2 * pulls + 2)
    expect(prs(db).find(row => row.pr === 800)).toMatchObject({ state: 'merged' })
    expect(db.prepare(`SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()).toEqual([])
    const built = projectionDump(db)
    reduce(db, 'rebuild')
    expect(projectionDump(db)).toBe(built)
    db.close()
  })

  it('a row another writer folded on append before the reduce is restored from the snapshot and folded again in event order, as a rebuild folds it', () => {
    const db = busWith(admitted(793))
    reduce(db)
    appendEvent(db, started(793))
    expect(appendedOnCard(db, event('card.stopped', { actor: 'worker:answer:a1', cardId: 793, payload: { reason: 'review', detail: 'x' } }))).toBe(true)
    appendEvent(db, admitted(794))
    expect(db.prepare(`SELECT tbl, k1 FROM ${DIRTY_ROWS}`).all()).toEqual([{ tbl: 'cards', k1: 793 }])

    reduce(db)
    expect(db.prepare(`SELECT count(*) AS n FROM ${DIRTY_ROWS}`).get()).toEqual({ n: 0 })
    const incremental = projectionDump(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[793, 'stopped'], [794, 'queued']])
    expect(rejections(db)).toEqual([])
    reduce(db, 'rebuild')
    expect(projectionDump(db)).toBe(incremental)
    db.close()
  })

  it('ignores legacy events and event types no fold reads', () => {
    const db = busWith(
      { ...observed(800, 793), actor: null, legacy: true },
      event('card.noted', { actor: 'worker:launch:s1', cardId: 793, payload: { from: 'lane-1', to: 'lane-2' } }),
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

  it('card.closed without a pull request closes a card verified by a report and rejects a card verified without one', () => {
    const verifiedBy = (cardId: number, payload: Record<string, unknown>): BusEvent => event('card.verified', { actor: 'worker:task-close:window', cardId, payload })
    const closing = (cardId: number): BusEvent => event('card.closed', { actor: 'worker:close:c1', cardId, payload: { verification: 'run' } })
    const db = busWith(admitted(793), started(793), verifiedBy(793, { verification: 'run', report: '/shift/report-793.md' }), closing(793), admitted(794), started(794), verifiedBy(794, { verification: 'run' }), closing(794))
    expect(reduce(db).rejected).toBe(1)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[793, 'closed'], [794, 'running']])
  })

  it('card.closed carrying a pull request is rejected for a card only verified by a report', () => {
    const db = busWith(admitted(795), started(795), event('card.verified', { actor: 'worker:task-close:window', cardId: 795, payload: { verification: 'run', report: '/shift/report-795.md' } }), event('card.closed', { actor: 'worker:close:c1', cardId: 795, pr: 820, payload: { verification: 'run' } }))
    expect(reduce(db).rejected).toBe(1)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[795, 'running']])
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

  it('an admission of a card the journal merged before it leaves the card merged, and of a card never merged queues it', () => {
    const journalMerge = event('merge', { actor: null as unknown as string, cardId: 795, dedupeKey: 'legacy:1:merge', payload: { event: 'merge', task: '795', by: 'owner' }, legacy: true })
    const admission = (cardId: number): BusEvent => event('card.admitted', { actor: 'reducer', cardId, payload: { lane: 'archive', depends: [], admission: `legacy:${cardId}:sha` } })
    const db = busWith(journalMerge, admission(795), admission(796))
    expect(reduce(db)).toEqual({ applied: 2, rejected: 0 })
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[795, 'merged'], [796, 'queued']])
    db.close()
  })

  it('a fall written by the ladder reaches the card as card.fell', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-ladder-fall-'))
    roots.push(root)
    const file = path.join(root, 'bus.db')
    const before = openBus(file)
    appendEvent(before, admitted(890))
    appendEvent(before, started(890))
    before.close()
    const isolated = process.env[BUS_DB_VARIABLE]
    process.env[BUS_DB_VARIABLE] = file
    try {
      recordFall(890, 'ladder-not-done', 's890')
    }
    finally {
      process.env[BUS_DB_VARIABLE] = isolated
    }
    const db = openBus(file)
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[890, 'fallen']])
    expect(db.prepare(`SELECT actor, json_extract(payload, '$.kind') AS kind FROM events WHERE type = 'card.fell'`).all()).toEqual([{ actor: 'worker:ladder:s890', kind: 'ladder-not-done' }])
    expect(rejections(db)).toEqual([])
    expect(ghostLines(file)).toMatchObject([{ event: 'fall', card: 890, kind: 'ladder-not-done' }])
    db.close()
  })

  it('a started card moved to dropped through the intake port is dropped', () => {
    const db = busWith(admitted(916), started(916), event('card.moved', { actor: 'worker:intake:by-hand', cardId: 916, payload: { lane: 'dropped' } }))
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[916, 'dropped']])
    expect(rejections(db)).toEqual([])
    db.close()
  })

  it('card.dropped moves the automaton to dropped from a started card, a queued card and a card the bus never admitted, and leaves a merged card merged', () => {
    const dropped = (cardId: number): BusEvent => event('card.dropped', { actor: 'worker:intake:by-hand', cardId, payload: { lane: 'dropped' } })
    const db = busWith(admitted(930), started(930), dropped(930), admitted(931), dropped(931), dropped(932), admitted(933), event('merge.done', { actor: 'worker:merge:s1', cardId: 933, pr: 933, payload: {} }), dropped(933))
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[930, 'dropped'], [931, 'dropped'], [932, 'dropped'], [933, 'merged']])
    expect(rejections(db)).toEqual([])
    db.close()
  })

  it('a sliced parent dropped naming its children ends dropped, and a drop naming children badly or without a reason is rejected', () => {
    const dropped = (cardId: number, payload: Record<string, unknown>): BusEvent => event('card.dropped', { actor: 'worker:intake:by-hand', cardId, payload: { lane: 'sliced', ...payload } })
    const db = busWith(
      admitted(934),
      dropped(934, { children: [935, 936], reason: 'sliced into #935, #936' }),
      admitted(937),
      dropped(937, { children: [938] }),
      dropped(937, { children: [937], reason: 'sliced into #937' }),
      dropped(937, { children: ['938'], reason: 'sliced into #938' }),
      dropped(937, { children: [], reason: 'sliced into nothing' }),
    )
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[934, 'dropped'], [937, 'queued']])
    expect(rejections(db)).toHaveLength(4)
    db.close()
  })

  it.each(['archive', 'dropped', 'superseded'])('a queued card moved into %s ends dropped, as does a backfilled card without state', (lane) => {
    const backfilled = event('card.admitted', { actor: 'worker:backfill:window', cardId: 918, payload: { source: 'backfill' } })
    const moved = (cardId: number): BusEvent => event('card.moved', { actor: 'worker:intake:by-hand', cardId, payload: { lane } })
    const db = busWith(admitted(917), moved(917), backfilled, moved(918))
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[917, 'dropped'], [918, 'dropped']])
    expect(rejections(db)).toEqual([])
    db.close()
  })

  it('a move into a terminal folder keeps a merged card merged, and a repeated move makes no new transition', () => {
    const db = busWith(admitted(919), event('merge.done', { actor: 'worker:merge:s1', cardId: 919, pr: 919, payload: {} }), event('card.moved', { actor: 'worker:intake:by-hand', cardId: 919, payload: { lane: 'archive' } }), admitted(920), event('card.moved', { actor: 'worker:intake:by-hand', cardId: 920, payload: { lane: 'archive' } }))
    reduce(db)
    const once = cards(db)
    appendEvent(db, event('card.moved', { actor: 'worker:intake:by-hand', cardId: 920, payload: { lane: 'archive' } }))
    reduce(db)
    expect(once.map(row => [row.card_id, row.state])).toEqual([[919, 'merged'], [920, 'dropped']])
    expect(cards(db)).toEqual(once)
    expect(rejections(db)).toEqual([])
    db.close()
  })

  it('a move into a lane or the root changes no state', () => {
    const db = busWith(admitted(921), event('card.moved', { actor: 'worker:intake:by-hand', cardId: 921, payload: { lane: 'lane-2' } }), event('card.moved', { actor: 'worker:intake:by-hand', cardId: 921, payload: { lane: 'parking' } }))
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[921, 'queued']])
    db.close()
  })

  it('a fall written after the card was dropped leaves it dropped without a rejection', () => {
    const db = busWith(admitted(916), started(916), event('card.moved', { actor: 'worker:intake:by-hand', cardId: 916, payload: { lane: 'dropped' } }), event('card.fell', { actor: 'worker:ladder:s916', cardId: 916, payload: { kind: 'ladder-not-done' } }))
    reduce(db)
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[916, 'dropped']])
    expect(rejections(db)).toEqual([])
    db.close()
  })

  it('facts imported after the card moved on are folded without a rejection', () => {
    const db = busWith(observed(800, 793), closed(800, true), event('card.closed', { actor: 'worker:close:c1', cardId: 793, payload: { verification: 'run' } }), admitted(793), event('review.recorded', { actor: 'worker:review:r1', cardId: 794, payload: { verdict: 'pass' } }))
    expect(reduce(db)).toEqual({ applied: 5, rejected: 0 })
    expect(cards(db).map(row => [row.card_id, row.state])).toEqual([[793, 'queued']])
    db.close()
  })
})

describe('the reducer of the owner_waits projection', () => {
  function waits(db: ReturnType<typeof openBus>): Record<string, unknown>[] {
    return (db.prepare('SELECT id, need, command, card_id, pr, state, answer FROM owner_waits ORDER BY id').all() as Record<string, unknown>[]).map(row => ({ ...row }))
  }

  it('a recorded decision closes the owner wait it answers', () => {
    const db = newBus()
    const ts = '2026-10-09T12:00:00.000Z'
    const live = openBusWait(db, ts, 'policy', { need: 'command', text: 'the merge queue merges unswitched', command: allowLiveCommand('merge') })
    const question = openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which path?', card: 1213, request: 7 })
    const other = openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which name?', card: 1214, request: 8 })
    expect(openBusWait(db, ts, 'policy', { need: 'command', text: 'again', command: allowLiveCommand('merge') })).toBe(live)
    recordDecision(db, { ts, decisionId: 900, text: '[owner] allow-live merge', cards: [] })
    recordDecision(db, { ts, decisionId: 901, text: '[owner] the first path', cards: [1213] })
    expect(reduce(db)).toEqual({ applied: 5, rejected: 0 })
    expect(waits(db)).toEqual([
      { id: live, need: 'command', command: 'pnpm decisions:add "[owner] allow-live merge"', card_id: null, pr: null, state: 'closed', answer: 'D-900' },
      { id: question, need: 'decision', command: null, card_id: 1213, pr: null, state: 'closed', answer: 'D-901' },
      { id: other, need: 'decision', command: null, card_id: 1214, pr: null, state: 'open', answer: null },
    ])
    expect([live, question, other]).toEqual(['Q1', 'Q2', 'Q3'])
    db.close()
  })

  it('a bare-text allow-live decision closes the wait the merge executor opened', () => {
    const db = newBus()
    const ts = '2026-10-09T12:00:00.000Z'
    const live = openBusWait(db, ts, 'policy', { need: 'command', text: 'the merge queue merges unswitched', command: allowLiveCommand('merge') })
    const review = openBusWait(db, ts, 'policy', { need: 'command', text: 'the review queue runs unswitched', command: allowLiveCommand('review') })
    recordDecision(db, { ts, decisionId: 902, text: '  allow-live merge ', cards: [] })
    reduce(db)
    expect(waits(db).map(wait => [wait.id, wait.state, wait.answer])).toEqual([[live, 'closed', 'D-902'], [review, 'open', null]])
    db.close()
  })

  it('a decision whose text ends in regex syntax folds and closes no wait', () => {
    const db = newBus()
    const ts = '2026-10-09T12:00:00.000Z'
    const live = openBusWait(db, ts, 'policy', { need: 'command', text: 'the merge queue merges unswitched', command: allowLiveCommand('merge') })
    recordDecision(db, { ts, decisionId: 903, text: '[owner] see (', cards: [] })
    recordDecision(db, { ts, decisionId: 904, text: '[owner] tags: [a', cards: [] })
    expect(reduce(db)).toEqual({ applied: 3, rejected: 0 })
    expect(waits(db).map(wait => [wait.id, wait.state, wait.answer])).toEqual([[live, 'open', null]])
    db.close()
  })

  it('a finding with no owner action is not an owner wait', () => {
    const finding = event(OWNER_WAIT_OPENED, { actor: 'policy', payload: { id: 'Q1', need: 'decision', text: 'main went red after PR #900' } })
    const unnamedMerge = event(OWNER_WAIT_OPENED, { actor: 'policy', payload: { id: 'Q2', need: 'merge', text: 'the owner merges something' } })
    const db = busWith(finding, unnamedMerge)
    expect(reduce(db)).toEqual({ applied: 0, rejected: 2 })
    expect(waits(db)).toEqual([])
    expect(rejections(db).map(row => (row.payload as { reason?: string }).reason)).toEqual([
      'the bus names no owner action for this decision: a finding for the backlog, not an owner wait',
      'the bus names no owner action for this merge: a finding for the backlog, not an owner wait',
    ])
    db.close()
  })

  it('a closed pull request closes the merge wait the owner-merges boundary opened', () => {
    const db = busWith(observed(800, 793))
    const id = openBusWait(db, '2026-10-09T12:00:00.000Z', 'policy', { need: 'merge', text: 'changes architecture/security-invariants.md', card: 793, pr: 800 })
    appendEvent(db, closed(800, true))
    reduce(db)
    expect(waits(db)).toEqual([{ id, need: 'merge', command: null, card_id: 793, pr: 800, state: 'closed', answer: 'PR #800 merged' }])
    db.close()
  })

  it('a held witness downgrade opens a decision wait on its card, which a decision scoped to the card closes', () => {
    const downgrade = event(CARD_WAITING, { actor: 'worker:intake:s1', cardId: 1216, payload: { reason: WITNESS_DOWNGRADE, witnesses: ['w; red on main'], actions: ['разрешить понижение свидетеля w; red on main у #1216'] } })
    const depends = event(CARD_WAITING, { actor: 'worker:intake:s1', cardId: 1217, payload: { depends: [1216] } })
    const db = busWith(downgrade, depends)
    const ts = '2026-10-09T12:00:00.000Z'
    expect(reduce(db)).toEqual({ applied: 2, rejected: 0 })
    const id = waits(db)[0]!.id as string
    expect(waits(db)).toEqual([{ id: expect.stringMatching(/^W\d+$/), need: 'decision', command: null, card_id: 1216, pr: null, state: 'open', answer: null }])
    expect(openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which path?', card: 1300, request: 7 })).toBe('Q1')
    recordDecision(db, { ts, decisionId: 905, text: '[owner] разрешить понижение свидетеля w; red on main у #1216', cards: [1216] })
    reduce(db)
    expect(waits(db).map(wait => [wait.id, wait.state, wait.answer])).toEqual([['Q1', 'open', null], [id, 'closed', 'D-905']])
    db.close()
  })

  function downgradeOf(cardId: number): BusEvent {
    return event(CARD_WAITING, { actor: 'worker:intake:s1', cardId, payload: { reason: WITNESS_DOWNGRADE, witnesses: ['w; red on main'], actions: [`разрешить понижение свидетеля w; red on main у #${cardId}`] } })
  }

  it('a dropped card closes its owner waits on the next tick', () => {
    const ts = '2026-10-09T12:00:00.000Z'
    const db = busWith(admitted(1262), downgradeOf(1262))
    const question = openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which path?', card: 1262, request: 7 })
    const other = openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which path?', card: 1263, request: 8 })
    reduce(db)
    expect(waits(db).filter(wait => wait.state === 'open')).toHaveLength(3)
    appendEvent(db, event('card.dropped', { actor: 'owner', cardId: 1262, payload: { replaced_by: 1263 } }))
    reduce(db)
    expect(waits(db).map(wait => [wait.id, wait.card_id, wait.state, wait.answer])).toEqual([
      [question, 1262, 'closed', 'card #1262 dropped'],
      [other, 1263, 'open', null],
      [expect.stringMatching(/^W\d+$/), 1262, 'closed', 'card #1262 dropped'],
    ])
    db.close()
  })

  it('a dropped card closes its open owner waits, the card.waiting kind included', () => {
    const ts = '2026-10-09T12:00:00.000Z'
    const db = busWith(admitted(1262))
    const question = openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which path?', card: 1262, request: 7 })
    appendEvent(db, event('card.dropped', { actor: 'owner', cardId: 1262, payload: { replaced_by: 1263 } }))
    appendEvent(db, downgradeOf(1262))
    reduce(db)
    expect(waits(db).map(wait => [wait.id, wait.state, wait.answer])).toEqual([
      [question, 'closed', 'card #1262 dropped'],
      [expect.stringMatching(/^W\d+$/), 'closed', 'card #1262 dropped'],
    ])
    db.close()
  })

  it('a closed card closes a witness-downgrade wait that arrives after it', () => {
    const db = busWith(admitted(1274), started(1274), opened(1274, 903), observed(903, 1274), closed(903, true), event('card.closed', { actor: 'owner', cardId: 1274, pr: 903 }), downgradeOf(1274))
    reduce(db)
    expect(waits(db).map(wait => [wait.card_id, wait.state, wait.answer])).toEqual([[1274, 'closed', 'card #1274 closed']])
    db.close()
  })

  it('a merged card closes its witness-downgrade wait', () => {
    const db = busWith(admitted(1216), started(1216), opened(1216, 900), observed(900, 1216), downgradeOf(1216))
    reduce(db)
    expect(waits(db).map(wait => wait.state)).toEqual(['open'])
    appendEvent(db, closed(900, true))
    reduce(db)
    expect(waits(db).map(wait => [wait.card_id, wait.state, wait.answer])).toEqual([[1216, 'closed', 'card #1216 merged']])
    db.close()
  })

  function openWaitOn(db: ReturnType<typeof openBus>, cardId: number, request: number): string {
    return openOwnerWait(db, '2026-10-09T12:00:00.000Z', 'policy', { need: 'decision', text: 'which path?', card: cardId, request })
  }

  it('a merge.done with no pr.closed closes the owner waits of its card', () => {
    const db = busWith(admitted(1264), started(1264), opened(1264, 901))
    const wait = openOwnerWait(db, '2026-10-09T12:00:00.000Z', 'policy', { need: 'command', text: 'run the release check', command: 'pnpm release:verify', card: 1264, request: 9 })
    reduce(db)
    appendEvent(db, event('merge.done', { actor: 'worker:merge:s1', cardId: 1264, pr: 901, head: HEAD, payload: { commit: MAIN, rule: 'auto' } }))
    reduce(db)
    expect(waits(db).map(each => [each.id, each.state, each.answer])).toEqual([[wait, 'closed', 'card #1264 merged']])
    db.close()
  })

  it('a merge does not close an open decision question of its card', () => {
    const db = busWith(admitted(1274), started(1274), opened(1274, 903), observed(903, 1274))
    const question = openWaitOn(db, 1274, 13)
    reduce(db)
    appendEvent(db, closed(903, true))
    appendEvent(db, event('merge.done', { actor: 'worker:merge:s1', cardId: 1274, pr: 903, head: HEAD, payload: { commit: MAIN, rule: 'auto' } }))
    reduce(db)
    expect(waits(db).map(each => [each.id, each.state, each.answer])).toEqual([[question, 'open', null]])
    appendEvent(db, event('card.closed', { actor: 'owner', cardId: 1274, pr: 903 }))
    reduce(db)
    expect(waits(db).map(each => [each.id, each.state])).toEqual([[question, 'closed']])
    db.close()
  })

  it('a done owner.wait.close closes the W wait', () => {
    const db = busWith(admitted(1280), downgradeOf(1280))
    reduce(db)
    const id = waits(db)[0]!.id as string
    expect(id).toMatch(/^W\d+$/)
    const refuse = (): never => {
      throw new Error('closing a wait uses no tool')
    }
    requestFromWindow(db, '2026-10-09T12:00:00.000Z', 'test', { kind: 'owner.wait.close', id, answer: 'the downgrade is withdrawn' })
    const tools = { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
    expect(new WindowRequests(db, () => new Date('2026-10-09T12:00:00.000Z'), tools).run()).toMatchObject([{ kind: 'done' }])
    expect(reduce(db).rejected).toBe(0)
    expect(waits(db).map(each => [each.id, each.state, each.answer])).toEqual([[id, 'closed', 'the downgrade is withdrawn']])
    db.close()
  })

  it('a done owner.wait.close leaves the W wait closed in the owner_waits projection', () => {
    const db = busWith(admitted(1262), downgradeOf(1262))
    reduce(db)
    const id = waits(db)[0]!.id as string
    appendEvent(db, event(OWNER_WAIT_CLOSED, { actor: null, legacy: true, dedupeKey: `${OWNER_WAIT_CLOSED}:${id}`, payload: { id, answer: 'a close the projection never applied' } }))
    reduce(db)
    expect(waits(db).map(each => each.state)).toEqual(['open'])
    const refuse = (): never => {
      throw new Error('closing a wait uses no tool')
    }
    const tools = { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
    const requests = new WindowRequests(db, () => new Date('2026-10-09T12:00:00.000Z'), tools)
    requestFromWindow(db, '2026-10-09T12:00:00.000Z', 'test', { kind: 'owner.wait.close', id, answer: 'card #1262 dropped, the wait is void' })
    requestFromWindow(db, '2026-10-09T12:00:01.000Z', 'test', { kind: 'owner.wait.close', id, answer: 'the same close again' })
    expect(requests.run().map(outcome => outcome.kind)).toEqual(['done', 'refused'])
    expect(reduce(db).rejected).toBe(0)
    expect(waits(db).map(each => [each.id, each.state, each.answer])).toEqual([[id, 'closed', 'card #1262 dropped, the wait is void']])
    db.close()
  })

  it('the round limit wait of red re-entries is opened, not rejected', () => {
    const db = newBus()
    const id = openOwnerWait(db, '2026-10-09T12:00:00.000Z', 'policy', { need: 'decision', text: reentryLimitWaitText(1290, 904), card: 1290, pr: 904 })
    expect(reduce(db)).toEqual({ applied: 1, rejected: 0 })
    expect(waits(db)).toEqual([{ id, need: 'decision', command: null, card_id: 1290, pr: 904, state: 'open', answer: null }])
    db.close()
  })

  it('a card.closed closes an owner wait opened on its card after the merge', () => {
    const db = busWith(admitted(1265), started(1265), opened(1265, 902), event('merge.done', { actor: 'worker:merge:s1', cardId: 1265, pr: 902, head: HEAD, payload: { commit: MAIN, rule: 'auto' } }))
    reduce(db)
    const wait = openWaitOn(db, 1265, 10)
    reduce(db)
    expect(waits(db).map(each => each.state)).toEqual(['open'])
    appendEvent(db, event('card.closed', { actor: 'owner', cardId: 1265, pr: 902 }))
    reduce(db)
    expect(waits(db).map(each => [each.id, each.state, each.answer])).toEqual([[wait, 'closed', 'card #1265 closed']])
    db.close()
  })

  it('a card.moved to a terminal lane closes the owner waits of its card, and a move to a working lane closes none', () => {
    const db = busWith(admitted(1266), admitted(1267))
    const kept = openWaitOn(db, 1266, 11)
    const ended = openWaitOn(db, 1267, 12)
    reduce(db)
    appendEvent(db, event('card.moved', { actor: 'owner', cardId: 1266, payload: { lane: 'lane-2' } }))
    appendEvent(db, event('card.moved', { actor: 'owner', cardId: 1267, payload: { lane: 'archive' } }))
    reduce(db)
    expect(waits(db).map(each => [each.id, each.state, each.answer])).toEqual([[kept, 'open', null], [ended, 'closed', 'card #1267 dropped']])
    db.close()
  })

  it('a card admitted after its held downgrade closes the downgrade wait as admitted, and a later downgrade opens a new one', () => {
    const db = busWith(admitted(1216), downgradeOf(1216), admitted(1216))
    reduce(db)
    expect(waits(db).map(wait => [wait.state, wait.answer])).toEqual([['closed', 'card #1216 admitted']])
    appendEvent(db, downgradeOf(1216))
    reduce(db)
    expect(waits(db).map(wait => wait.state)).toEqual(['closed', 'open'])
    db.close()
  })

  it('a witness downgrade that names no action for the owner is rejected', () => {
    const db = busWith(event(CARD_WAITING, { cardId: 1216, payload: { reason: WITNESS_DOWNGRADE, actions: [] } }), event(CARD_WAITING, { payload: { reason: WITNESS_DOWNGRADE, actions: ['a'] } }))
    expect(reduce(db)).toEqual({ applied: 0, rejected: 2 })
    expect(waits(db)).toEqual([])
    db.close()
  })
})

describe('the plan journal', () => {
  const plan = (type: string, payload: Record<string, unknown>, actor = 'owner'): BusEvent => event(type, { actor, payload })
  const opening = plan('plan.opened', { id: 'p-045', title: 'Plan 0.45', goal: 'explicit journals', plan_file: '/plans/0.45.md' })

  it('plan events build the plans and plan_items projections, and a replay rebuilds the same rows', () => {
    const db = busWith(
      opening,
      plan('plan.item.added', { plan: 'p-045', item: 'S1', title: 'slice one' }),
      plan('plan.item.added', { plan: 'p-045', item: 'S2', title: 'slice two' }),
      plan('plan.item.added', { plan: 'p-045', item: 'S3', title: 'slice three' }),
      plan('plan.item.linked', { plan: 'p-045', item: 'S1', card: 901 }),
      plan('plan.item.linked', { plan: 'p-045', item: 'S1', card: 902 }),
      plan('plan.item.removed', { plan: 'p-045', item: 'S3' }),
    )
    expect(reduce(db)).toEqual({ applied: 7, rejected: 0 })
    const rows = (): unknown => [db.prepare('SELECT plan_id, title, goal, plan_file, state FROM plans').all(), db.prepare('SELECT plan_id, item_id, title, cards FROM plan_items ORDER BY item_id').all()]
    expect(rows()).toEqual([
      [{ plan_id: 'p-045', title: 'Plan 0.45', goal: 'explicit journals', plan_file: '/plans/0.45.md', state: 'open' }],
      [{ plan_id: 'p-045', item_id: 'S1', title: 'slice one', cards: '[901,902]' }, { plan_id: 'p-045', item_id: 'S2', title: 'slice two', cards: '[]' }],
    ])
    const first = rows()
    reduce(db)
    expect(rows()).toEqual(first)
    db.close()
  })

  it('a plan event from anyone but the owner, on a closed plan, on an unknown item or linking a card twice is rejected', () => {
    const db = busWith(
      plan('plan.opened', { id: 'p-x', title: 'X', goal: 'g', plan_file: '/plans/x.md' }, 'netwatch'),
      opening,
      plan('plan.opened', { id: 'p-045', title: 'again', goal: 'g', plan_file: '/plans/0.45.md' }),
      plan('plan.item.linked', { plan: 'p-045', item: 'S9', card: 901 }),
      plan('plan.item.added', { plan: 'p-045', item: 'S1', title: 'slice one' }),
      plan('plan.item.linked', { plan: 'p-045', item: 'S1', card: 901 }),
      plan('plan.item.linked', { plan: 'p-045', item: 'S1', card: 901 }),
      plan('plan.closed', { plan: 'p-045' }),
      plan('plan.item.added', { plan: 'p-045', item: 'S2', title: 'late' }),
      plan('plan.closed', { plan: 'p-045' }),
    )
    expect(reduce(db)).toEqual({ applied: 4, rejected: 6 })
    expect(rejections(db).map(row => (row.payload as { reason: string }).reason)).toEqual([
      'plan.opened is the owner\'s, not netwatch\'s',
      'plan p-045 was opened before',
      'plan p-045 has no item S9',
      'card 901 is already linked to item S1',
      'plan p-045 is not open',
      'plan p-045 is not open',
    ])
    expect(db.prepare('SELECT state FROM plans').all()).toEqual([{ state: 'closed' }])
    db.close()
  })
})
