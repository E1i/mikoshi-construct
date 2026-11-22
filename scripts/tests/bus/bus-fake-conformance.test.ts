import type { BusEvent } from '../../core/db.js'
import type { EventRow, EventsQuery } from '../../core/events-query.js'
import type { ReduceCount, ReduceScope } from '../../core/reducer.js'
import type { Fold, StoredEvent } from '../../core/stored.js'
import type { FakeFold } from './bus-fake.js'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { all, byId, EITHER_JOURNAL, events, latest, ofCard, ofPr, perCard } from '../../core/events-query.js'
import { CARD_PULSE, CARD_STARTED, GATE_RUN, REJECTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { reject, Rejection } from '../../core/stored.js'
import { BusFake } from './bus-fake.js'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const WORKER = 'worker:launch:s1'
const NOW = '2026-11-22T10:00:00.000Z'

interface Subject {
  append: (event: BusEvent) => boolean
  events: (query?: EventsQuery) => EventRow[]
  all: (types?: readonly string[], query?: Omit<EventsQuery, 'types'>) => EventRow[]
  ofCard: (card: number, query?: Omit<EventsQuery, 'card'>) => EventRow[]
  ofPr: (pr: number, query?: Omit<EventsQuery, 'pr'>) => EventRow[]
  byId: (id: number) => EventRow | null
  latest: (query: EventsQuery) => EventRow | null
  perCard: (query?: Omit<EventsQuery, 'card'>) => Map<number, EventRow[]>
  reduce: (scope: ReduceScope, folds: Record<string, FakeFold>) => ReduceCount
  close: () => void
}

function realBus(): Subject {
  const db = openBus(':memory:')
  const foldsOf = (folds: Record<string, FakeFold>): Record<string, Fold> =>
    Object.fromEntries(Object.entries(folds).map(([type, fold]) => [type, (_db: unknown, event: StoredEvent) => fold({ ...event })]))
  return {
    append: event => appendEvent(db, event),
    events: query => events(db, query),
    all: (types, query) => all(db, types, query),
    ofCard: (card, query) => ofCard(db, card, query),
    ofPr: (pr, query) => ofPr(db, pr, query),
    byId: id => byId(db, id),
    latest: query => latest(db, query),
    perCard: query => perCard(db, query),
    reduce: (scope, folds) => reduce(db, scope, { folds: [foldsOf(folds)], incremental: [] }),
    close: () => db.close(),
  }
}

function fakeBus(): Subject {
  const fake = new BusFake({ isRejection: error => error instanceof Rejection })
  return {
    append: event => fake.append(event),
    events: query => fake.events(query),
    all: (types, query) => fake.all(types, query),
    ofCard: (card, query) => fake.ofCard(card, query),
    ofPr: (pr, query) => fake.ofPr(pr, query),
    byId: id => fake.byId(id),
    latest: query => fake.latest(query),
    perCard: query => fake.perCard(query),
    reduce: (scope, folds) => fake.reduce(scope, { folds: [folds] }),
    close: () => {},
  }
}

function event(fields: Partial<BusEvent> & Pick<BusEvent, 'dedupeKey'>): BusEvent {
  return { ts: NOW, type: CARD_STARTED, actor: WORKER, cardId: null, pr: null, head: null, payload: {}, legacy: false, ...fields }
}

function seedMixedLog(bus: Subject): void {
  bus.append(event({ dedupeKey: 'a', cardId: 7, payload: { task_key: 'launch:7' } }))
  bus.append(event({ dedupeKey: 'b', type: CARD_PULSE, cardId: 7, pr: 40, head: HEAD, actor: 'netwatch' }))
  bus.append(event({ dedupeKey: 'c', type: GATE_RUN, cardId: 3, pr: 41, ts: '2026-11-22T11:00:00.000Z', payload: { task_key: 5 } }))
  bus.append(event({ dedupeKey: 'd', cardId: 3, payload: 'not json' }))
  bus.append(event({ dedupeKey: 'e', type: CARD_PULSE, legacy: true, actor: null, ts: null, cardId: 7 }))
  bus.append(event({ dedupeKey: 'f', type: GATE_RUN, actor: 'worker:review:s2', payload: [1, 2] }))
  bus.append(event({ dedupeKey: 'g', cardId: 12, pr: 40, actor: 'owner', payload: { task_key: 'launch:7', note: 'again' } }))
}

const QUERIES: Readonly<Record<string, EventsQuery>> = {
  'everything': {},
  'by types': { types: [CARD_PULSE, GATE_RUN] },
  'no types': { types: [] },
  'by card': { card: 7 },
  'by pr': { pr: 40 },
  'with no pr': { pr: null },
  'by task': { task: 'launch:7' },
  'by a numeric task key': { task: '5' },
  'since': { since: 2 },
  'before': { before: 4 },
  'by ids': { ids: [1, 5, 6, 99] },
  'no ids': { ids: [] },
  'by keys': { keys: ['b', 'e', 'z'] },
  'no keys': { keys: [] },
  'by ts': { ts: '2026-11-22T11:00:00.000Z' },
  'by actor prefix': { actorPrefix: 'worker:' },
  'by an empty actor prefix': { actorPrefix: '' },
  'legacy only': { legacy: true },
  'either journal': { legacy: EITHER_JOURNAL },
  'newest first': { newestFirst: true },
  'limit': { limit: 2 },
  'negative limit': { limit: -1 },
  'fractional limit': { limit: 1.7 },
  'combined': { types: [CARD_STARTED], since: 1, newestFirst: true, limit: 1, legacy: EITHER_JOURNAL },
}

function attempt(work: () => unknown): unknown {
  try {
    return work()
  }
  catch {
    return 'throws'
  }
}

type Scenario = (bus: Subject) => unknown

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'an append is kept once per dedupe key and numbered in order': (bus) => {
    const appended = [
      bus.append(event({ dedupeKey: 'one' })),
      bus.append(event({ dedupeKey: 'one', type: GATE_RUN })),
      bus.append(event({ dedupeKey: 'two', payload: 'raw text' })),
    ]
    return { appended, rows: bus.events({ legacy: EITHER_JOURNAL }) }
  },
  'an invalid event is refused and leaves the log as it was': (bus) => {
    const tries = [
      event({ dedupeKey: 'no-type', type: '' }),
      event({ dedupeKey: '' }),
      event({ dedupeKey: 'bad-actor', actor: 'someone' }),
      event({ dedupeKey: 'no-actor', actor: null }),
      event({ dedupeKey: 'no-ts', ts: null }),
      event({ dedupeKey: 'zero-pr', pr: 0 }),
      event({ dedupeKey: 'fractional-pr', pr: 1.5 }),
      event({ dedupeKey: 'short-head', head: 'abc123' }),
      event({ dedupeKey: 'legacy', legacy: true, actor: null, ts: null }),
      event({ dedupeKey: 'after', pr: 3, head: HEAD }),
    ].map(each => attempt(() => bus.append(each)))
    return { tries, rows: bus.events({ legacy: EITHER_JOURNAL }) }
  },
  'every query filter selects the same rows': (bus) => {
    seedMixedLog(bus)
    return Object.fromEntries(Object.entries(QUERIES).map(([name, query]) => [name, bus.events(query)]))
  },
  'the query helpers answer the same': (bus) => {
    seedMixedLog(bus)
    return {
      all: bus.all([GATE_RUN]),
      allUntyped: bus.all(undefined, { card: 3 }),
      ofCard: bus.ofCard(7, { legacy: EITHER_JOURNAL }),
      ofPr: bus.ofPr(40, { newestFirst: true }),
      legacyById: bus.byId(5),
      missingById: bus.byId(99),
      latest: bus.latest({ card: 7 }),
      noLatest: bus.latest({ card: 404 }),
      perCard: [...bus.perCard()],
      perCardEither: [...bus.perCard({ legacy: EITHER_JOURNAL })],
    }
  },
  'a pending reduce folds each new event once, in order': (bus) => {
    const seen: StoredEvent[] = []
    const folds = { [CARD_STARTED]: (stored: StoredEvent) => seen.push(stored), [GATE_RUN]: (stored: StoredEvent) => seen.push(stored) }
    seedMixedLog(bus)
    const first = bus.reduce('pending', folds)
    bus.append(event({ dedupeKey: 'later', type: GATE_RUN, cardId: 9 }))
    bus.append(event({ dedupeKey: 'later-legacy', legacy: true, actor: null, ts: null }))
    const second = bus.reduce('pending', folds)
    const third = bus.reduce('pending', folds)
    return { first, second, third, seen, rows: bus.events({ legacy: EITHER_JOURNAL }) }
  },
  'a rebuild folds the whole log again': (bus) => {
    const seen: number[] = []
    const folds = { [CARD_STARTED]: (stored: StoredEvent) => seen.push(stored.id) }
    seedMixedLog(bus)
    const pending = bus.reduce('pending', folds)
    const rebuild = bus.reduce('rebuild', folds)
    return { pending, rebuild, seen }
  },
  'a rejected event is counted and recorded once': (bus) => {
    const seen: number[] = []
    const folds = {
      [CARD_STARTED]: (stored: StoredEvent) => {
        if (stored.card_id === 3)
          reject(`card ${stored.card_id} is refused`)
        seen.push(stored.id)
      },
      [REJECTED]: (stored: StoredEvent) => seen.push(-stored.id),
    }
    seedMixedLog(bus)
    const first = bus.reduce('pending', folds)
    const second = bus.reduce('pending', folds)
    const rebuild = bus.reduce('rebuild', folds)
    return { first, second, rebuild, seen, rejected: bus.all([REJECTED]) }
  },
  'a fold that fails without a rejection stops the reduce': (bus) => {
    seedMixedLog(bus)
    const brokenFold = (): void => {
      throw new Error('broken fold')
    }
    const failed = attempt(() => bus.reduce('pending', { [GATE_RUN]: brokenFold }))
    const seen: number[] = []
    const after = bus.reduce('pending', { [GATE_RUN]: (stored: StoredEvent) => seen.push(stored.id) })
    return { failed, after, seen, rows: bus.events() }
  },
}

describe('the in-memory bus fake answers the bus contract like the real bus', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(Object.entries(SCENARIOS))('%s', (_name, scenario) => {
    const real = realBus()
    const fake = fakeBus()
    try {
      const expected = scenario(real)
      expect(expected).not.toEqual({})
      expect(scenario(fake)).toEqual(expected)
    }
    finally {
      real.close()
      fake.close()
    }
  })

  it('the fake imports no bus file but the types of its contract', () => {
    const source = readFileSync(new URL('./bus-fake.ts', import.meta.url), 'utf8')
    const imports = source.split('\n').filter(line => line.startsWith('import '))
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every(line => line.startsWith('import type '))).toBe(true)
  })
})
