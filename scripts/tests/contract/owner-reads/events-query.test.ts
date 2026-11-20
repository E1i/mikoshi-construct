import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../../core/db.js'
import { all, byId, EITHER_JOURNAL, events, latest, ofCard, ofPr, perCard } from '../../../core/events-query.js'
import { CARD_ADMITTED, CARD_HELD, CARD_STOPPED, TASK_FAILED } from '../../../core/events.js'
import { lastEventId } from '../../../core/watermark.js'

const TS = '2026-11-20T08:00:00.000Z'
const LATER = '2026-11-20T09:00:00.000Z'
const CARD = 7
const OTHER_CARD = 8
const PR = 41
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  opened.push(db)
  return db
}

interface Seed {
  type: string
  card?: number | null
  pr?: number | null
  key: string
  payload?: Record<string, unknown> | string
  ts?: string
  actor?: string
  legacy?: boolean
}

function append(db: DatabaseSync, seed: Seed): number {
  appendEvent(db, { ts: seed.ts ?? TS, type: seed.type, actor: seed.actor ?? 'policy', cardId: seed.card ?? null, pr: seed.pr ?? null, head: null, dedupeKey: seed.key, payload: seed.payload ?? {}, legacy: seed.legacy ?? false })
  return lastEventId(db)
}

function seeded(): { db: DatabaseSync, ids: Record<string, number> } {
  const db = bus()
  const ids = {
    admitted: append(db, { type: CARD_ADMITTED, card: CARD, key: 'a1', payload: { text: 'body' } }),
    stopped: append(db, { type: CARD_STOPPED, card: CARD, key: 's1', payload: { reason: 'fault' } }),
    other: append(db, { type: CARD_STOPPED, card: OTHER_CARD, key: 's2', payload: { reason: 'review' } }),
    onPr: append(db, { type: CARD_STOPPED, card: CARD, pr: PR, key: 's3', payload: { reason: 'ci' } }),
    failed: append(db, { type: TASK_FAILED, card: CARD, key: 'f1', payload: { task_key: 'answer:7', reason: 'held_for_owner' }, ts: LATER, actor: 'worker:intake:one' }),
    unreadable: append(db, { type: CARD_HELD, card: CARD, key: 'h1', payload: 'not json' }),
    journal: append(db, { type: 'merge', card: CARD, key: 'm1', legacy: true }),
  }
  return { db, ids }
}

function idsOf(rows: readonly { id: number }[]): number[] {
  return rows.map(row => row.id)
}

function sqlIds(db: DatabaseSync, sql: string, ...values: (number | string)[]): number[] {
  return (db.prepare(sql).all(...values) as { id: number }[]).map(row => Number(row.id))
}

describe('events query', () => {
  it('events query returns the events of the named types for a card, a pr or past an id as values', () => {
    const { db, ids } = seeded()
    expect(idsOf(ofCard(db, CARD, { types: [CARD_STOPPED] }))).toEqual(sqlIds(db, 'SELECT id FROM events WHERE legacy = 0 AND type = ? AND card_id = ? ORDER BY id', CARD_STOPPED, CARD))
    expect(idsOf(ofPr(db, PR))).toEqual([ids.onPr])
    expect(idsOf(events(db, { types: [CARD_STOPPED], card: CARD, pr: null }))).toEqual([ids.stopped])
    expect(idsOf(all(db, [CARD_STOPPED], { since: ids.stopped }))).toEqual([ids.other, ids.onPr])
    expect(idsOf(events(db, { before: ids.other }))).toEqual([ids.admitted, ids.stopped])
    expect(idsOf(events(db, { ids: [ids.failed, ids.admitted, ids.journal] }))).toEqual([ids.admitted, ids.failed])
    expect(idsOf(events(db, { task: 'answer:7' }))).toEqual([ids.failed])
    expect(ofCard(db, CARD, { types: [CARD_STOPPED] })[0]!.data).toEqual({ reason: 'fault' })
  })

  it('returns the whole stored row, with the payload as stored and as values, and no data for a payload that is not an object', () => {
    const { db, ids } = seeded()
    const row = byId(db, ids.failed)!
    expect(row).toMatchObject({ id: ids.failed, ts: LATER, type: TASK_FAILED, actor: 'worker:intake:one', card_id: CARD, pr: null, head: null, dedupe_key: 'f1', legacy: false })
    expect(JSON.parse(row.payload)).toEqual(row.data)
    expect(byId(db, ids.unreadable)!.data).toBeNull()
    expect(byId(db, lastEventId(db) + 1)).toBeNull()
  })

  it('reads the live journal by default, the legacy one when asked, and both by either', () => {
    const { db, ids } = seeded()
    expect(idsOf(ofCard(db, CARD, { types: ['merge'] }))).toEqual([])
    expect(idsOf(ofCard(db, CARD, { types: ['merge'], legacy: true }))).toEqual([ids.journal])
    expect(idsOf(events(db, { keys: ['m1', 'a1'], legacy: EITHER_JOURNAL }))).toEqual([ids.admitted, ids.journal])
    expect(byId(db, ids.journal)!.legacy).toBe(true)
  })

  it('takes the latest first and limits, matching ORDER BY id DESC LIMIT 1', () => {
    const { db, ids } = seeded()
    expect(latest(db, { types: [CARD_STOPPED], card: CARD })!.id).toBe(sqlIds(db, 'SELECT id FROM events WHERE legacy = 0 AND type = ? AND card_id = ? ORDER BY id DESC LIMIT 1', CARD_STOPPED, CARD)[0])
    expect(latest(db, { types: [CARD_STOPPED], card: CARD, before: ids.onPr })!.id).toBe(ids.stopped)
    expect(latest(db, { types: ['card.unknown'] })).toBeNull()
  })

  it('matches by ts and by actor prefix as written, not as a LIKE pattern', () => {
    const { db, ids } = seeded()
    expect(idsOf(events(db, { card: CARD, ts: LATER, actorPrefix: 'worker:intake:' }))).toEqual([ids.failed])
    expect(idsOf(events(db, { card: CARD, actorPrefix: 'worker:%' }))).toEqual([])
  })

  it('groups per card in card order and leaves out an event that names no card', () => {
    const { db, ids } = seeded()
    append(db, { type: CARD_STOPPED, key: 'no-card', payload: { reason: 'fault' } })
    const grouped = perCard(db, { types: [CARD_STOPPED] })
    expect([...grouped.keys()]).toEqual([CARD, OTHER_CARD])
    expect(idsOf(grouped.get(CARD)!)).toEqual([ids.stopped, ids.onPr])
  })

  it('answers an empty list of types, ids or keys with no events', () => {
    const { db } = seeded()
    expect(events(db, { types: [] })).toEqual([])
    expect(events(db, { ids: [] })).toEqual([])
    expect(events(db, { keys: [] })).toEqual([])
  })
})
