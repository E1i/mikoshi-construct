import type { BusPanelRow } from '../../../scripts/core/card-readings.js'

export interface BusEventLine {
  id: number
  ts: string | null
  type: string
  card: number | null
  detail: string | null
}

export interface BusFamily {
  family: string
  count: number
}

export interface BusAlarm {
  reason: string | null
  card: number | null
  ts: string | null
}

export interface BusWorker {
  process: string
  ts: string
}

export interface BusPanelFacts {
  lastEvent: { id: number, ts: string | null } | null
  minutes: number[]
  families: BusFamily[]
  familyTotal: number
  reducerLag: number | null
  rateRemaining: number | null
  pulses: string[]
  workers: BusWorker[]
  alarm: BusAlarm | null
  recent: BusEventLine[]
}

const MINUTE_MS = 60_000
const FLOW_MINUTES = 30
const TOP_FAMILIES = 4
export const RECENT_EVENTS = 4
const DETAIL_CHARS = 48
const DETAIL_FIELDS = ['reason', 'verdict', 'step', 'queue', 'lane', 'detail']

export function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function minuteCounts(rows: readonly { ts: string | null }[], now: Date): number[] {
  const minutes = Array.from<number>({ length: FLOW_MINUTES }).fill(0)
  for (const row of rows) {
    const back = Math.floor((now.getTime() - Date.parse(row.ts ?? '')) / MINUTE_MS)
    if (back >= 0 && back < FLOW_MINUTES)
      minutes[FLOW_MINUTES - 1 - back]! += 1
  }
  return minutes
}

function familiesOf(rows: readonly { type: string }[]): BusFamily[] {
  const counted = new Map<string, number>()
  for (const row of rows) {
    const family = row.type.split('.')[0]!
    counted.set(family, (counted.get(family) ?? 0) + 1)
  }
  return [...counted].map(([family, n]) => ({ family, count: n })).sort((a, b) => b.count - a.count || a.family.localeCompare(b.family)).slice(0, TOP_FAMILIES)
}

function detailOf(payload: Record<string, unknown>): string | null {
  const found = DETAIL_FIELDS.map(field => text(payload[field])).find(value => value !== null) ?? null
  return found === null ? null : found.slice(0, DETAIL_CHARS)
}

interface PanelEvent {
  id: number
  ts: string | null
  type: string
  card: number | null
  payload: string
}

function jsonOf<T>(value: string | null, empty: T): T {
  return value === null ? empty : JSON.parse(value) as T
}

function newestFirst<T extends { id: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.id - a.id)
}

function alarmOf(value: string | null): BusAlarm | null {
  const row = jsonOf<{ ts: string | null, card: number | null, payload: string } | null>(value, null)
  return row === null ? null : { reason: text(payloadOf(row.payload).reason), card: row.card, ts: row.ts }
}

export function panelSince(now: Date): string {
  return new Date(now.getTime() - FLOW_MINUTES * MINUTE_MS).toISOString()
}

export function busPanelFacts(row: BusPanelRow, now: Date): BusPanelFacts {
  const last = jsonOf<{ id: number, ts: string | null } | null>(row.last, null)
  const halfHour = jsonOf<{ ts: string | null, type: string }[]>(row.half_hour, [])
  const ticks = newestFirst(jsonOf<{ id: number, ts: string | null, payload: string }[]>(row.ticks, []))
  const rate = ticks[0] === undefined ? null : payloadOf(ticks[0].payload).rate_remaining
  return {
    lastEvent: last,
    minutes: minuteCounts(halfHour, now),
    families: familiesOf(halfHour),
    familyTotal: halfHour.length,
    reducerLag: row.through === null || last === null ? null : Math.max(0, last.id - Number(row.through)),
    rateRemaining: typeof rate === 'number' && Number.isFinite(rate) ? rate : null,
    pulses: ticks.flatMap(tick => tick.ts ?? []),
    workers: jsonOf<BusWorker[]>(row.workers, []).sort((a, b) => a.process.localeCompare(b.process)),
    alarm: alarmOf(row.alarm),
    recent: newestFirst(jsonOf<PanelEvent[]>(row.recent, [])).map(event => ({ id: event.id, ts: event.ts, type: event.type, card: event.card, detail: detailOf(payloadOf(event.payload)) })),
  }
}
