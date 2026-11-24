import type { DatabaseSync } from 'node:sqlite'
import type { EventData, EventRow, EventsQuery, Reading, ReadProjection, StaleProjection } from '../core/events-query.js'
import type { EventType, PayloadKey } from '../core/events.js'
import { BY_CARD, EITHER_JOURNAL, events, lastPer, readCurrent, staleProjection } from '../core/events-query.js'
import { EVENT_PAYLOADS } from '../core/events.js'

export const BUS_TABLES = ['card_bodies', 'card_releases', 'cards', 'chains', 'decisions', 'events', 'heartbeats', 'mains', 'node_cursors', 'owner_waits', 'plan_items', 'plans', 'projection_watermarks', 'prs', 'roles', 'tasks'] as const

export type SliceFields<T extends EventType, K extends PayloadKey<T>> = { readonly [P in K]?: unknown }

export interface EventSlice<T extends EventType, K extends PayloadKey<T>> {
  id: number
  ts: string | null
  actor: string | null
  card: number | null
  pr: number | null
  head: string | null
  fields: SliceFields<T, K>
}

export const ANY = 'any'

export interface SliceWhere {
  card?: number | typeof ANY
  pr?: number | typeof ANY
  from?: number
  actor?: string
  present?: readonly string[]
  legacy?: boolean
  limit?: number
}

export const SLICE_TAKES = ['all', 'last', 'last-per-card', 'newest'] as const

export type SliceTake = typeof SLICE_TAKES[number]

function holdsEvery(data: EventData | null, present: readonly string[]): data is EventData {
  return data !== null && present.every(field => data[field] !== undefined && data[field] !== null)
}

function byCardThenId(a: EventRow, b: EventRow): number {
  return (a.card_id ?? Number.NEGATIVE_INFINITY) - (b.card_id ?? Number.NEGATIVE_INFINITY) || a.id - b.id
}

const SLICE_BY_TAKE: Readonly<Record<SliceTake, (db: DatabaseSync, match: EventsQuery, present: readonly string[], limit?: number) => EventRow[]>> = {
  'all': (db, match, present) => events(db, { ...match, present }),
  'last': (db, match, present) => events(db, { ...match, present, newestFirst: true, limit: 1 }),
  'last-per-card': (db, match, present) => lastPer(db, BY_CARD, match).filter(row => holdsEvery(row.data, present)).sort(byCardThenId),
  'newest': (db, match, present, limit) => events(db, { ...match, present, newestFirst: true, limit }),
}

export interface CardNobodyHolds {
  card: number
  state: string
  pr: number | null
  lastEvent: { id: number, type: string, ts: string }
}

interface CardNobodyHoldsRow {
  card_id: number
  state: string
  pr: number | null
  last_id: number
  last_type: string
  last_ts: string
}

const CARDS_NOBODY_HOLDS = `
  SELECT cards.card_id, cards.state, cards.pr, last.id AS last_id, last.type AS last_type, last.ts AS last_ts FROM cards
  JOIN events AS last ON last.id = (SELECT max(id) FROM events WHERE card_id = cards.card_id AND actor IS NOT :ignoredActor)
  WHERE cards.state IS NOT NULL AND cards.state NOT IN (SELECT value FROM json_each(:heldElsewhere))
    AND NOT EXISTS (SELECT 1 FROM prs WHERE prs.card_id = cards.card_id AND prs.state = 'merged')
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.card_id = cards.card_id AND tasks.state IN ('queued', 'leased'))
  ORDER BY cards.card_id
`

function exact(value: number | typeof ANY | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function sliceMatch(type: EventType, where: SliceWhere): EventsQuery {
  return {
    types: [type],
    card: exact(where.card),
    withCard: where.card === ANY,
    pr: exact(where.pr),
    withPr: where.pr === ANY,
    since: where.from === undefined ? undefined : where.from - 1,
    actorPrefix: where.actor,
    legacy: where.legacy === true ? EITHER_JOURNAL : false,
  }
}

export function undeclaredFields(type: EventType, fields: readonly string[]): string[] {
  const declared: readonly string[] = EVENT_PAYLOADS[type]
  return fields.filter(field => !declared.includes(field))
}

function picked<T extends EventType, K extends PayloadKey<T>>(payload: Record<string, unknown>, fields: readonly K[]): SliceFields<T, K> {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(payload, field)).map(field => [field, payload[field]])) as SliceFields<T, K>
}

export class BusRead {
  constructor(private readonly db: DatabaseSync, private readonly filter: SliceWhere = {}) {}

  where(filter: SliceWhere): BusRead {
    return new BusRead(this.db, { ...this.filter, ...filter })
  }

  slice<T extends EventType, K extends PayloadKey<T>>(type: T, fields: readonly K[], take: SliceTake = 'all'): EventSlice<T, K>[] {
    const undeclared = undeclaredFields(type, [...fields, ...this.filter.present ?? []])
    if (undeclared.length > 0)
      throw new Error(`${type} declares no payload field ${undeclared.join(', ')} in EVENT_PAYLOADS of scripts/core/events.ts, so no slice reads it`)
    const rows = SLICE_BY_TAKE[take](this.db, sliceMatch(type, this.filter), this.filter.present ?? [], this.filter.limit)
    return rows.map(row => ({
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      card: row.card_id,
      pr: row.pr,
      head: row.head,
      fields: picked<T, K>(row.data ?? {}, fields),
    }))
  }

  cardsNobodyHolds(heldElsewhere: readonly string[], ignoredActor: string): CardNobodyHolds[] {
    const rows = this.db.prepare(CARDS_NOBODY_HOLDS).all({ heldElsewhere: JSON.stringify(heldElsewhere), ignoredActor }) as unknown as CardNobodyHoldsRow[]
    return rows.map(row => ({ card: Number(row.card_id), state: row.state, pr: row.pr === null ? null : Number(row.pr), lastEvent: { id: Number(row.last_id), type: row.last_type, ts: row.last_ts } }))
  }

  current<R>(projections: readonly ReadProjection[], read: () => R): Reading<R> {
    return readCurrent(this.db, projections, read)
  }

  stale(projection: ReadProjection): StaleProjection | null {
    return staleProjection(this.db, projection)
  }
}
