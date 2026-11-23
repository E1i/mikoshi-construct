import type { BusEvent } from '../../core/db.js'
import type { EventData, EventRow, EventsQuery } from '../../core/events-query.js'
import type { ReduceCount, ReduceScope } from '../../core/reducer.js'
import type { StoredEvent } from '../../core/stored.js'

export type FakeFold = (event: StoredEvent) => void

export interface FakeProjections {
  folds: readonly Readonly<Record<string, FakeFold>>[]
}

export interface BusFakeOptions {
  isRejection?: (error: unknown) => boolean
}

const FIXED_ACTORS = new Set(['netwatch', 'reducer', 'owner', 'policy'])
const WORKER_ACTOR = /^worker:[a-z][a-z-]*:[^:\s]+$/
const FULL_SHA = /^[0-9a-f]{40}$/
const DECISIONS_CUT_OVER = 'decisions.cut-over'
const REJECTED = 'reducer.rejected'
const REDUCER_ACTOR = 'reducer'

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function checked(event: BusEvent): BusEvent {
  if (event.type === '')
    throw new Error('an event needs a type')
  if (event.dedupeKey === '')
    throw new Error('an event needs a dedupe_key')
  if (!event.legacy && (event.actor === null || !(FIXED_ACTORS.has(event.actor) || WORKER_ACTOR.test(event.actor))))
    throw new Error(`actor is not one of netwatch | reducer | worker:<kind>:<session> | owner | policy: ${event.actor}`)
  if (!event.legacy && event.ts === null)
    throw new Error('an event needs a ts')
  if (event.pr !== null && !positiveInteger(event.pr))
    throw new Error(`pr is not a positive integer: ${event.pr}`)
  if (event.head !== null && !FULL_SHA.test(event.head))
    throw new Error(`head is not a full sha: ${event.head}`)
  if (event.payload === undefined)
    throw new Error('an event needs a payload')
  return event
}

function dataOf(payload: string): EventData | null {
  try {
    const parsed = JSON.parse(payload) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as EventData : null
  }
  catch {
    return null
  }
}

function taskKeyOf(payload: string): unknown {
  return dataOf(payload)?.task_key
}

function storedOf(row: EventRow): StoredEvent {
  return { id: row.id, ts: row.ts, type: row.type, card_id: row.card_id, pr: row.pr, head: row.head, dedupe_key: row.dedupe_key, payload: row.payload }
}

function matches(row: EventRow, query: EventsQuery): boolean {
  const legacy = query.legacy ?? false
  return (legacy === 'either' || row.legacy === legacy)
    && (query.types === undefined || query.types.includes(row.type))
    && (query.card === undefined || row.card_id === query.card)
    && (query.pr === undefined || row.pr === query.pr)
    && (query.task === undefined || taskKeyOf(row.payload) === query.task)
    && (query.since === undefined || row.id > query.since)
    && (query.before === undefined || row.id < query.before)
    && (query.ids === undefined || query.ids.includes(row.id))
    && (query.keys === undefined || query.keys.includes(row.dedupe_key))
    && (query.ts === undefined || row.ts === query.ts)
    && (query.actorPrefix === undefined || (row.actor !== null && row.actor.startsWith(query.actorPrefix)))
}

export class BusFake {
  private readonly rows: EventRow[] = []
  private readonly keys = new Set<string>()
  private nextId = 1
  private reducedThrough = 0
  private readonly isRejection: (error: unknown) => boolean

  constructor(options: BusFakeOptions = {}) {
    this.isRejection = options.isRejection ?? (() => false)
  }

  append(event: BusEvent): boolean {
    const valid = checked(event)
    const id = this.nextId++
    if (this.keys.has(valid.dedupeKey))
      return false
    const payload = typeof valid.payload === 'string' ? valid.payload : JSON.stringify(valid.payload)
    this.keys.add(valid.dedupeKey)
    this.rows.push({
      id,
      ts: valid.ts as string,
      type: valid.type,
      actor: valid.actor,
      card_id: valid.cardId,
      pr: valid.pr,
      head: valid.head,
      dedupe_key: valid.dedupeKey,
      payload,
      legacy: valid.legacy,
      data: dataOf(payload),
    })
    return true
  }

  events(query: EventsQuery = {}): EventRow[] {
    if (query.types?.length === 0 || query.ids?.length === 0 || query.keys?.length === 0)
      return []
    const found = this.rows.filter(row => matches(row, query))
    const ordered = query.newestFirst === true ? found.reverse() : found
    const limited = query.limit === undefined ? ordered : ordered.slice(0, Math.max(0, Math.trunc(query.limit)))
    return limited.map(row => ({ ...row, data: dataOf(row.payload) }))
  }

  all(types?: readonly string[], query: Omit<EventsQuery, 'types'> = {}): EventRow[] {
    return this.events({ ...query, types })
  }

  ofCard(card: number, query: Omit<EventsQuery, 'card'> = {}): EventRow[] {
    return this.events({ ...query, card })
  }

  ofPr(pr: number, query: Omit<EventsQuery, 'pr'> = {}): EventRow[] {
    return this.events({ ...query, pr })
  }

  byId(id: number): EventRow | null {
    return this.events({ ids: [id], legacy: 'either' })[0] ?? null
  }

  latest(query: EventsQuery): EventRow | null {
    return this.events({ ...query, newestFirst: true, limit: 1 })[0] ?? null
  }

  perCard(query: Omit<EventsQuery, 'card'> = {}): Map<number, EventRow[]> {
    const grouped = new Map<number, EventRow[]>()
    for (const row of this.events(query)) {
      if (row.card_id === null)
        continue
      grouped.set(row.card_id, [...grouped.get(row.card_id) ?? [], row])
    }
    return new Map([...grouped].sort(([a], [b]) => a - b))
  }

  reduce(scope: ReduceScope, projections: FakeProjections): ReduceCount {
    const folds: Record<string, FakeFold> = Object.assign({}, ...projections.folds)
    this.append({ ts: new Date().toISOString(), type: DECISIONS_CUT_OVER, actor: REDUCER_ACTOR, cardId: null, pr: null, head: null, dedupeKey: DECISIONS_CUT_OVER, payload: {}, legacy: false })
    const target = this.rows.at(-1)?.id ?? 0
    const from = scope === 'rebuild' ? 0 : this.reducedThrough
    const count: ReduceCount = { applied: 0, rejected: 0 }
    const due = this.rows.filter(row => row.id > from && row.id <= target && !row.legacy && Object.hasOwn(folds, row.type))
    for (const row of due) {
      if (this.applied(row, folds[row.type]!))
        count.applied += 1
      else
        count.rejected += 1
    }
    this.reducedThrough = Math.max(from, target)
    return count
  }

  private applied(row: EventRow, fold: FakeFold): boolean {
    try {
      fold(storedOf(row))
      return true
    }
    catch (error) {
      if (!this.isRejection(error))
        throw error
      this.append({
        ts: row.ts,
        type: REJECTED,
        actor: REDUCER_ACTOR,
        cardId: row.card_id,
        pr: row.pr,
        head: row.head,
        dedupeKey: `${REJECTED}:${row.dedupe_key}`,
        payload: { event_id: row.id, type: row.type, reason: error instanceof Error ? error.message : String(error) },
        legacy: false,
      })
      return false
    }
  }
}
