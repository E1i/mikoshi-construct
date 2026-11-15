import type { DatabaseSync } from 'node:sqlite'
import { appendEvent } from '../core/db.js'
import { ANSWER_STEP, BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, REVIEW_RECORDED, SESSION_HEARTBEAT, TASK_LEASED } from '../core/events.js'

export const MIN_SAMPLES = 3
export const EXPECTED_PERCENTILE = 0.9
export const OVER_TIME = 'over_time'
export const NOT_ENOUGH_DATA = 'not enough data'
export const EXPECTED_TIME_ACTOR = 'worker:supervisor:expected-time'
const UNKNOWN = '?'
const MINUTE_MS = 60_000
const SECOND_MS = 1000

export type RoundKind = 'answer' | 'review'
export type SampleKind = RoundKind | 'answer step'

export interface RoundSample {
  kind: SampleKind
  size: string
  contour: string
  minutes: number
}

export interface Shape {
  size: string
  contour: string
}

export interface RoundReading {
  card: number
  queue: RoundKind
  shape: Shape
  elapsed: number
  expected: number | null
  samples: number
  line: string
}

export type ActionOf = (cardId: number, session: string | null) => string | null

const CARD_LINE_SHAPE = /\[[^/\]]+\/[^/\]]+\/([A-Z]+)\/([a-z-]+)(?:\/|\])/

function cardLineOf(card: string): string {
  return `coalesce(
    (SELECT b.card_line FROM card_bodies b WHERE b.card_id = ${card}),
    (SELECT json_extract(a.payload, '$.text') FROM events a WHERE a.legacy = 0 AND a.type = '${CARD_ADMITTED}' AND a.card_id = ${card} AND json_valid(a.payload) ORDER BY a.id DESC LIMIT 1)
  )`
}

const MEASURED = `
  SELECT e.type, json_extract(e.payload, '$.minutes') AS minutes, json_extract(e.payload, '$.review_ms') AS review_ms, json_extract(e.payload, '$.seconds') AS seconds, ${cardLineOf('e.card_id')} AS line FROM events e
  WHERE e.legacy = 0 AND e.type IN ('${CARD_ANSWERED}', '${REVIEW_RECORDED}', '${ANSWER_STEP}') AND json_valid(e.payload)
  ORDER BY e.id
`

const LEASED_ROUNDS = `
  SELECT t.task_key, t.queue, t.card_id, t.pr, t.head, t.lease_gen, ${cardLineOf('t.card_id')} AS line FROM tasks t
  WHERE t.state = 'leased' AND t.queue IN ('answer', 'review')
  ORDER BY t.id
`

const LEASED_AT = `SELECT ts FROM events WHERE type = '${TASK_LEASED}' AND dedupe_key = ?`

const ROUND_SESSION = `
  SELECT json_extract(payload, '$.session') AS session FROM events
  WHERE type = '${SESSION_HEARTBEAT}' AND legacy = 0 AND json_valid(payload) AND json_extract(payload, '$.task_key') = ? AND json_extract(payload, '$.lease_gen') = ?
    AND json_type(payload, '$.session') = 'text'
  ORDER BY id DESC LIMIT 1
`

interface LeasedRound {
  task_key: string
  queue: RoundKind
  card_id: number
  pr: number | null
  head: string | null
  lease_gen: number
  line: string | null
}

export function shapeOf(line: string | null): Shape {
  const found = line === null ? null : CARD_LINE_SHAPE.exec(line)
  return found === null ? { size: UNKNOWN, contour: UNKNOWN } : { size: found[1]!, contour: found[2]! }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

interface MeasuredRow {
  type: string
  minutes: unknown
  review_ms: unknown
  seconds: unknown
  line: string | null
}

function minutesOf(type: string, payload: MeasuredRow): { kind: SampleKind, minutes: number } | null {
  if (type === CARD_ANSWERED) {
    const minutes = positive(payload.minutes)
    return minutes === null ? null : { kind: 'answer', minutes }
  }
  if (type === REVIEW_RECORDED) {
    const ms = positive(payload.review_ms)
    return ms === null ? null : { kind: 'review', minutes: ms / MINUTE_MS }
  }
  const seconds = positive(payload.seconds)
  return seconds === null ? null : { kind: 'answer step', minutes: seconds * SECOND_MS / MINUTE_MS }
}

export function roundSamples(db: DatabaseSync): RoundSample[] {
  return (db.prepare(MEASURED).all() as unknown as MeasuredRow[]).flatMap((row) => {
    const measured = minutesOf(row.type, row)
    return measured === null ? [] : [{ ...measured, ...shapeOf(row.line) }]
  })
}

function matching(samples: readonly RoundSample[], kind: SampleKind, shape: Shape): number[] {
  return samples.filter(sample => sample.kind === kind && sample.size === shape.size && sample.contour === shape.contour).map(sample => sample.minutes).sort((a, b) => a - b)
}

export function expectedMinutes(samples: readonly RoundSample[], kind: RoundKind, shape: Shape): number | null {
  const measured = matching(samples, kind, shape)
  if (shape.size === UNKNOWN || shape.contour === UNKNOWN || measured.length < MIN_SAMPLES)
    return null
  return Math.ceil(measured[Math.ceil(measured.length * EXPECTED_PERCENTILE) - 1]!)
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`
}

export function coverageLines(samples: readonly RoundSample[]): string[] {
  const keys = [...new Set(samples.map(sample => `${sample.kind}\n${sample.size}\n${sample.contour}`))].sort()
  if (keys.length === 0)
    return [`no round measured in the bus (answer.step, card.answered minutes, review_ms): ${NOT_ENOUGH_DATA} for any size and contour`]
  return keys.map((key) => {
    const [kind, size, contour] = key.split('\n') as [SampleKind, string, string]
    const count = matching(samples, kind, { size, contour }).length
    const expected = kind === 'answer step' ? null : expectedMinutes(samples, kind, { size, contour })
    const verdict = kind === 'answer step' ? 'steps, not rounds: no expected round time' : expected === null ? `${NOT_ENOUGH_DATA} (fewer than ${MIN_SAMPLES})` : `expected within ${expected} min`
    return `${kind} ${size}/${contour}: ${plural(count, 'sample')} · ${verdict}`
  })
}

export function roundLine(reading: Omit<RoundReading, 'line'>): string {
  const shape = `${reading.shape.size}/${reading.shape.contour}`
  if (reading.expected === null)
    return `the ${reading.queue} round of card #${reading.card} has run ${reading.elapsed} min; ${NOT_ENOUGH_DATA} for ${shape} (${plural(reading.samples, 'round')} measured), so no expected time and no warning`
  const past = reading.elapsed > reading.expected
  return `the ${reading.queue} round of card #${reading.card} has run ${reading.elapsed} min ${past ? 'past' : 'within'} its expected ${reading.expected} min for ${shape} (${plural(reading.samples, 'round')} measured)`
}

export class RoundOverTime {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly actionOf: ActionOf) {}

  readings(): (RoundReading & { round: LeasedRound })[] {
    const now = this.clock().getTime()
    const samples = roundSamples(this.db)
    return (this.db.prepare(LEASED_ROUNDS).all() as unknown as LeasedRound[]).flatMap((round) => {
      const leased = this.db.prepare(LEASED_AT).get(`${TASK_LEASED}:${round.task_key}:${round.lease_gen}`) as { ts: string } | undefined
      if (leased === undefined)
        return []
      const shape = shapeOf(round.line)
      const reading = { card: Number(round.card_id), queue: round.queue, shape, elapsed: Math.floor((now - Date.parse(leased.ts)) / MINUTE_MS), expected: expectedMinutes(samples, round.queue, shape), samples: matching(samples, round.queue, shape).length }
      return [{ ...reading, line: roundLine(reading), round }]
    })
  }

  check(): string[] {
    const ts = this.clock().toISOString()
    return this.readings().flatMap((reading) => {
      if (reading.expected === null || reading.elapsed <= reading.expected)
        return []
      const { round } = reading
      const session = (this.db.prepare(ROUND_SESSION).get(round.task_key, Number(round.lease_gen)) as { session: string } | undefined)?.session ?? null
      const action = this.actionOf(reading.card, session) ?? 'what it does now is not read: no transcript of its session was found'
      const detail = `${reading.line}; the session runs on and is not stopped; ${action}`
      const raised = appendEvent(this.db, { ts, type: BOARD_ALARM, actor: EXPECTED_TIME_ACTOR, cardId: reading.card, pr: round.pr, head: round.head, dedupeKey: `${BOARD_ALARM}:${OVER_TIME}:${round.task_key}:${round.lease_gen}`, payload: { task_key: round.task_key, lease_gen: Number(round.lease_gen), reason: OVER_TIME, detail }, legacy: false })
      return raised ? [`${BOARD_ALARM} #${reading.card} ${OVER_TIME}: ${detail}`] : []
    })
  }
}
