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

export const PANEL_READING = `SELECT
  (SELECT json_object('id', id, 'ts', ts) FROM events ORDER BY id DESC LIMIT 1) AS last,
  (SELECT json_group_array(json_object('ts', ts, 'type', type)) FROM events WHERE ts >= :since) AS half_hour,
  (SELECT through_event_id FROM projection_watermarks WHERE projection = :mark) AS through,
  (SELECT json_group_array(json_object('id', id, 'ts', ts, 'payload', payload)) FROM (SELECT id, ts, payload FROM events WHERE type = :pulse ORDER BY id DESC LIMIT 2)) AS ticks,
  (SELECT json_group_array(json_object('id', id, 'ts', ts, 'type', type, 'card', card_id, 'payload', payload)) FROM (SELECT id, ts, type, card_id, payload FROM events WHERE type NOT IN (SELECT value FROM json_each(:quiet)) ORDER BY id DESC LIMIT :recent)) AS recent,
  (SELECT json_group_array(json_object('process', process, 'ts', ts)) FROM heartbeats WHERE type = :heartbeat) AS workers,
  (SELECT json_object('ts', a.ts, 'card', a.card_id, 'payload', a.payload) FROM events a WHERE a.type = :alarm AND NOT EXISTS (SELECT 1 FROM events c WHERE c.type = :cleared AND json_valid(c.payload) AND json_extract(c.payload, '$.alarm') = a.dedupe_key) ORDER BY a.id DESC LIMIT 1) AS alarm`

export interface PanelRow {
  last: string | null
  half_hour: string
  through: number | null
  ticks: string
  recent: string
  workers: string
  alarm: string | null
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

export function busPanelFacts(row: PanelRow, now: Date): BusPanelFacts {
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
