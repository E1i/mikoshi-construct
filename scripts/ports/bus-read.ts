import type { DatabaseSync } from 'node:sqlite'
import type { Reading, ReadProjection, StaleProjection } from '../core/bus-readings.js'
import type { EventType, PayloadKey } from '../core/events.js'
import { readCurrent, staleProjection } from '../core/bus-readings.js'
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

interface SliceRow {
  id: number
  ts: string | null
  actor: string | null
  card: number | null
  pr: number | null
  head: string | null
  payload: string
}

const SLICE_COLUMNS = 'id, ts, actor, card_id AS card, pr, head, payload'

const UNLIMITED = -1

const SLICE_MATCH = `type = :type AND (:withLegacy = 1 OR legacy = 0)
  AND (:card IS NULL OR card_id = :card) AND (:anyCard = 0 OR card_id IS NOT NULL)
  AND (:pr IS NULL OR pr = :pr) AND (:anyPr = 0 OR pr IS NOT NULL)
  AND id >= :from AND (:actor IS NULL OR substr(actor, 1, length(:actor)) = :actor)`

const SLICE_PRESENT = `NOT EXISTS (SELECT 1 FROM json_each(:present) AS wanted WHERE json_extract(payload, '$.' || wanted.value) IS NULL)`

const SLICE_WHERE = `${SLICE_MATCH} AND json_valid(payload) AND ${SLICE_PRESENT}`

const SLICE_BY_TAKE: Readonly<Record<SliceTake, string>> = {
  'all': `SELECT ${SLICE_COLUMNS} FROM events WHERE ${SLICE_WHERE} ORDER BY id`,
  'last': `SELECT ${SLICE_COLUMNS} FROM events WHERE ${SLICE_WHERE} ORDER BY id DESC LIMIT 1`,
  'last-per-card': `SELECT ${SLICE_COLUMNS} FROM events WHERE id IN (SELECT max(id) FROM events WHERE ${SLICE_MATCH} GROUP BY card_id) AND json_valid(payload) AND ${SLICE_PRESENT} ORDER BY card_id, id`,
  'newest': `SELECT ${SLICE_COLUMNS} FROM events WHERE ${SLICE_WHERE} ORDER BY id DESC LIMIT :limit`,
}

function exact(value: number | typeof ANY | undefined): number | null {
  return typeof value === 'number' ? value : null
}

function sliceParameters(type: EventType, where: SliceWhere): Record<string, string | number | null> {
  return {
    type,
    card: exact(where.card),
    anyCard: where.card === ANY ? 1 : 0,
    pr: exact(where.pr),
    anyPr: where.pr === ANY ? 1 : 0,
    from: where.from ?? 0,
    actor: where.actor ?? null,
    present: JSON.stringify(where.present ?? []),
    withLegacy: where.legacy === true ? 1 : 0,
    limit: where.limit ?? UNLIMITED,
  }
}

function payloadObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
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
    const statement = this.db.prepare(SLICE_BY_TAKE[take])
    statement.setAllowUnknownNamedParameters(true)
    const rows = statement.all(sliceParameters(type, this.filter)) as unknown as SliceRow[]
    return rows.map(({ payload, ...row }) => ({
      id: Number(row.id),
      ts: row.ts,
      actor: row.actor,
      card: row.card === null ? null : Number(row.card),
      pr: row.pr === null ? null : Number(row.pr),
      head: row.head,
      fields: picked<T, K>(payloadObject(payload), fields),
    }))
  }

  current<R>(projections: readonly ReadProjection[], read: () => R): Reading<R> {
    return readCurrent(this.db, projections, read)
  }

  stale(projection: ReadProjection): StaleProjection | null {
    return staleProjection(this.db, projection)
  }
}
