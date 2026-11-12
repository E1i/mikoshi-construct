import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { CARDS, staleLine } from '../../core/bus-readings.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_STARTED, EVENT_PAYLOADS, SESSION_HEARTBEAT, SHARD_DECIDED, WINDOW_HEARTBEAT } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { ANY, BusRead } from '../../ports/bus-read.js'
import { cardGauges, shardDecisions, windowGauges } from '../../window/board.js'

const TS = '2026-11-09T08:00:00.000Z'
const LATER = '2026-11-09T08:05:00.000Z'
const CARD = 7
const OTHER_CARD = 8
const PORT = path.join(import.meta.dirname, '..', '..', 'ports', 'bus-read.ts')
const SQL_WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/
const opened: DatabaseSync[] = []
const roots: string[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
})

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function bus(file = ':memory:'): DatabaseSync {
  const db = openBus(file)
  opened.push(db)
  return db
}

const SHOWN_SHARD_DECISIONS = 20

function append(db: DatabaseSync, type: typeof SESSION_HEARTBEAT | typeof WINDOW_HEARTBEAT | typeof CARD_STARTED | typeof SHARD_DECIDED, ts: string, cardId: number | null, payload: Record<string, unknown>, key: string): void {
  appendEvent(db, { ts, type, actor: `worker:test:${key}`, cardId, pr: null, head: null, dedupeKey: `${type}:${key}`, payload, legacy: false })
}

function appendLegacy(db: DatabaseSync, type: typeof SESSION_HEARTBEAT | typeof WINDOW_HEARTBEAT | typeof SHARD_DECIDED, cardId: number | null, payload: Record<string, unknown>, key: string): void {
  appendEvent(db, { ts: LATER, type, actor: `worker:test:${key}`, cardId, pr: null, head: null, dedupeKey: `${type}:legacy-${key}`, payload, legacy: true })
}

function appendRaw(db: DatabaseSync, type: string, cardId: number, payload: string, key: string): void {
  db.prepare('INSERT INTO events (ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 0)').run(LATER, type, `worker:test:${key}`, cardId, `${type}:${key}`, payload)
}

describe('the bus read port', () => {
  it('a slice has the fields of the event contract', () => {
    const db = bus()
    append(db, SESSION_HEARTBEAT, TS, CARD, { session: 's-1', step: 'launch', context: 1200, spent: 3, model: 'm' }, 'first')
    append(db, SESSION_HEARTBEAT, LATER, CARD, { session: 's-1', step: 'launch', context: 1500, spent: 4 }, 'second')

    const slice = new BusRead(db).where({ card: CARD }).slice(SESSION_HEARTBEAT, ['context', 'model'])

    expect(slice.map(row => row.fields)).toEqual([{ context: 1200, model: 'm' }, { context: 1500 }])
    for (const row of slice)
      expect(Object.keys(row.fields).every(field => (EVENT_PAYLOADS[SESSION_HEARTBEAT] as readonly string[]).includes(field))).toBe(true)
    expect(slice.map(row => ({ card: row.card, ts: row.ts }))).toEqual([{ card: CARD, ts: TS }, { card: CARD, ts: LATER }])
    expect(new BusRead(db).where({ card: ANY }).slice(SESSION_HEARTBEAT, ['context'], 'last-per-card').map(row => row.fields)).toEqual([{ context: 1500 }])
    expect(() => new BusRead(db).slice(SESSION_HEARTBEAT, ['lane' as never])).toThrow(/declares no payload field lane/)
  })

  it('a board and a node read the same slice through the port', () => {
    const db = bus()
    const subagents = [{ name: 'review', context: 900, spent: 1, at: TS }]
    append(db, WINDOW_HEARTBEAT, TS, null, { session: 'tab-0', context: 100, spent: 1, subagents: [] }, 'old')
    append(db, WINDOW_HEARTBEAT, LATER, null, { session: 'tab-1', context: 2000, spent: 5, model: 'm', subagents }, 'new')

    append(db, SESSION_HEARTBEAT, TS, CARD, { session: 's-7', context: 300, spent: 1 }, 'seven-old')
    append(db, SESSION_HEARTBEAT, LATER, CARD, { session: 's-7', context: 700, spent: 2, model: 'm' }, 'seven-new')
    append(db, SESSION_HEARTBEAT, TS, OTHER_CARD, { session: 's-8', context: 800 }, 'eight')

    const node = new BusRead(db).slice(WINDOW_HEARTBEAT, ['session', 'context', 'spent', 'subagents'], 'last')
    const nodeCards = new BusRead(db).where({ card: ANY }).slice(SESSION_HEARTBEAT, ['context', 'spent', 'model'], 'last-per-card')

    expect(node).toHaveLength(1)
    expect(node[0]!.fields).toEqual({ session: 'tab-1', context: 2000, spent: 5, subagents })
    expect(windowGauges(db)).toEqual({ session: node[0]!.fields.session, ts: node[0]!.ts, context: node[0]!.fields.context, spent: node[0]!.fields.spent, model: 'm' })
    expect(cardGauges(db)).toEqual(nodeCards.map(row => ({ card: row.card, ts: row.ts, context: row.fields.context, spent: row.fields.spent ?? null, model: row.fields.model ?? null })))
    expect(cardGauges(db).map(gauges => gauges.card)).toEqual([CARD, OTHER_CARD])
  })

  it('a slice behind its events reads stale', () => {
    const db = bus()
    append(db, CARD_STARTED, TS, CARD, {}, String(CARD))
    let read = 0
    const reading = new BusRead(db).current([CARDS], () => ++read)

    expect(read).toBe(0)
    expect(reading.stale).not.toBeNull()
    expect(staleLine(reading.stale!)).toMatch(/^cards is stale: reduced through event 0, behind card\.started \d+$/)
    const started = reading.stale!.latest
    reduce(db)
    expect(new BusRead(db).current([CARDS], () => ++read)).toEqual({ stale: null, rows: 1, at: started })
  })

  it('reads only: a read-only bus answers, and the port holds no SQL that writes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-read-'))
    roots.push(root)
    const file = path.join(root, 'bus.db')
    const written = bus(file)
    append(written, SESSION_HEARTBEAT, TS, CARD, { context: 10 }, 'only')
    reduce(written)
    const readOnly = new DatabaseSync(file, { readOnly: true })
    opened.push(readOnly)

    expect(new BusRead(readOnly).slice(SESSION_HEARTBEAT, ['context']).map(row => row.fields)).toEqual([{ context: 10 }])
    expect(new BusRead(readOnly).stale(CARDS)).toBeNull()
    expect(SQL_WRITE.test(readFileSync(PORT, 'utf8'))).toBe(false)
  })

  it('the board shows the newest stopped shard decisions first, capped, and skips one without a stop', () => {
    const db = bus()
    const total = SHOWN_SHARD_DECISIONS + 3
    for (let n = 1; n <= total; n++)
      append(db, SHARD_DECIDED, TS, n, { shard: `ws-${n}`, wait: 'w', answer: `a-${n}`, stop: 'question.owner' }, `stopped-${n}`)
    append(db, SHARD_DECIDED, LATER, CARD, { shard: 'ws-none', wait: 'w', answer: 'a', stop: null }, 'no-stop')
    append(db, SHARD_DECIDED, LATER, OTHER_CARD, { shard: 'ws-absent', wait: 'w', answer: 'a' }, 'absent-stop')

    const shown = shardDecisions(db)

    expect(shown).toHaveLength(SHOWN_SHARD_DECISIONS)
    expect(shown.map(row => row.card)).toEqual(Array.from({ length: SHOWN_SHARD_DECISIONS }, (_, index) => total - index))
    expect(shown.some(row => row.shard === 'ws-none' || row.shard === 'ws-absent')).toBe(false)
  })

  it('the board drops a card whose newest heartbeat is not json, and does not fall back to an older beat', () => {
    const db = bus()
    append(db, SESSION_HEARTBEAT, TS, CARD, { context: 300, spent: 1 }, 'seven-valid')
    appendRaw(db, SESSION_HEARTBEAT, CARD, 'not json', 'seven-broken')
    append(db, SESSION_HEARTBEAT, TS, OTHER_CARD, { context: 800 }, 'eight')

    expect(cardGauges(db).map(gauges => gauges.card)).toEqual([OTHER_CARD])
  })

  it('the board reads past legacy events: a newer legacy beat or decision is not shown', () => {
    const db = bus()
    append(db, SESSION_HEARTBEAT, TS, CARD, { context: 300, spent: 1 }, 'seven-live')
    appendLegacy(db, SESSION_HEARTBEAT, CARD, { context: 9999, spent: 99 }, 'seven')
    appendLegacy(db, SESSION_HEARTBEAT, OTHER_CARD, { context: 800 }, 'eight')
    append(db, WINDOW_HEARTBEAT, TS, null, { session: 'tab-live', context: 100, spent: 1 }, 'window-live')
    appendLegacy(db, WINDOW_HEARTBEAT, null, { session: 'tab-legacy', context: 9999, spent: 99 }, 'window')
    append(db, SHARD_DECIDED, TS, CARD, { shard: 'ws-live', wait: 'w', answer: 'a', stop: 'question.owner' }, 'decided-live')
    appendLegacy(db, SHARD_DECIDED, OTHER_CARD, { shard: 'ws-legacy', wait: 'w', answer: 'a', stop: 'question.owner' }, 'decided')

    expect(cardGauges(db).map(gauges => ({ card: gauges.card, context: gauges.context }))).toEqual([{ card: CARD, context: 300 }])
    expect(windowGauges(db)?.session).toBe('tab-live')
    expect(shardDecisions(db).map(row => row.shard)).toEqual(['ws-live'])
    expect(new BusRead(db).where({ card: ANY, legacy: true }).slice(SESSION_HEARTBEAT, ['context'], 'last-per-card').map(row => row.fields.context)).toEqual([9999, 800])
  })
})
