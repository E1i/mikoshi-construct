import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../core/lease.js'
import { appendEvent } from '../core/db.js'
import { ANSWER_STEP, BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_DROPPED, CARD_RELEASED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, MERGE_DONE, PR_OBSERVED, PR_OPENED, REVIEW_RECORDED, SESSION_HEARTBEAT } from '../core/events.js'
import { ANY, BusRead } from '../ports/bus-read.js'

export const MIN_SAMPLES = 3
export const EXPECTED_PERCENTILE = 0.9
export const OVER_TIME = 'over_time'
export const NOT_ENOUGH_DATA = 'not enough data'
export const EXPECTED_TIME_ACTOR = 'worker:supervisor:expected-time'
const UNKNOWN = '?'
const MINUTE_MS = 60_000
const SECOND_MS = 1000
const ROUND_QUEUES: readonly string[] = ['answer', 'review']

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

export interface LeasedRound {
  lease: Lease
  session: string | null
  leasedAt: string
}

export type ActionOf = (cardId: number, session: string | null) => string | null

const CARD_LINE_SHAPE = /\[[^/\]]+\/[^/\]]+\/([A-Z]+)\/([a-z-]+)(?:\/|\])/

export function shapeOf(line: string | null): Shape {
  const found = line === null ? null : CARD_LINE_SHAPE.exec(line)
  return found === null ? { size: UNKNOWN, contour: UNKNOWN } : { size: found[1]!, contour: found[2]! }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

interface CardMinutes {
  card: number | null
  kind: SampleKind
  minutes: number
}

function measured(card: number | null, kind: SampleKind, minutes: number | null): CardMinutes[] {
  return minutes === null ? [] : [{ card, kind, minutes }]
}

export class RoundMeasures {
  private readonly lines = new Map<number, string>()
  private readonly taken: CardMinutes[] = []
  private from = 0

  constructor(private readonly db: DatabaseSync) {}

  shapeOfCard(card: number): Shape {
    return shapeOf(this.lines.get(card) ?? null)
  }

  samples(): RoundSample[] {
    this.readNew()
    return this.taken.map(({ card, kind, minutes }) => ({ kind, minutes, ...shapeOf(card === null ? null : this.lines.get(card) ?? null) }))
  }

  private readNew(): void {
    const read = new BusRead(this.db).where({ from: this.from })
    let last = this.from - 1
    for (const admitted of read.where({ card: ANY }).slice(CARD_ADMITTED, ['text'], 'last-per-card')) {
      if (typeof admitted.fields.text === 'string')
        this.lines.set(admitted.card!, admitted.fields.text)
      last = Math.max(last, admitted.id)
    }
    const answered = read.slice(CARD_ANSWERED, ['minutes']).flatMap(event => measured(event.card, 'answer', positive(event.fields.minutes)).map(sample => ({ ...sample, id: event.id })))
    const reviewed = read.slice(REVIEW_RECORDED, ['review_ms']).flatMap((event) => {
      const ms = positive(event.fields.review_ms)
      return measured(event.card, 'review', ms === null ? null : ms / MINUTE_MS).map(sample => ({ ...sample, id: event.id }))
    })
    const steps = read.slice(ANSWER_STEP, ['seconds']).flatMap((event) => {
      const seconds = positive(event.fields.seconds)
      return measured(event.card, 'answer step', seconds === null ? null : seconds * SECOND_MS / MINUTE_MS).map(sample => ({ ...sample, id: event.id }))
    })
    for (const { id, ...sample } of [...answered, ...reviewed, ...steps].sort((a, b) => a.id - b.id)) {
      this.taken.push(sample)
      last = Math.max(last, id)
    }
    this.from = last + 1
  }
}

export function roundSamples(db: DatabaseSync): RoundSample[] {
  return new RoundMeasures(db).samples()
}

function matching(samples: readonly RoundSample[], kind: SampleKind, shape: Shape): number[] {
  return samples.filter(sample => sample.kind === kind && sample.size === shape.size && sample.contour === shape.contour).map(sample => sample.minutes).sort((a, b) => a - b)
}

export function expectedMinutes(samples: readonly RoundSample[], kind: RoundKind, shape: Shape): number | null {
  const measuredMinutes = matching(samples, kind, shape)
  if (shape.size === UNKNOWN || shape.contour === UNKNOWN || measuredMinutes.length < MIN_SAMPLES)
    return null
  return Math.ceil(measuredMinutes[Math.ceil(measuredMinutes.length * EXPECTED_PERCENTILE) - 1]!)
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
  private readonly measures: RoundMeasures

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly actionOf: ActionOf) {
    this.measures = new RoundMeasures(db)
  }

  readings(rounds: readonly LeasedRound[]): (RoundReading & { round: LeasedRound })[] {
    const timed = rounds.filter(round => ROUND_QUEUES.includes(round.lease.queue))
    if (timed.length === 0)
      return []
    const now = this.clock().getTime()
    const samples = this.measures.samples()
    return timed.map((round) => {
      const queue = round.lease.queue as RoundKind
      const shape = this.measures.shapeOfCard(round.lease.cardId)
      const reading = { card: round.lease.cardId, queue, shape, elapsed: Math.floor((now - Date.parse(round.leasedAt)) / MINUTE_MS), expected: expectedMinutes(samples, queue, shape), samples: matching(samples, queue, shape).length }
      return { ...reading, line: roundLine(reading), round }
    })
  }

  check(rounds: readonly LeasedRound[]): string[] {
    const ts = this.clock().toISOString()
    return this.readings(rounds).flatMap((reading) => {
      if (reading.expected === null || reading.elapsed <= reading.expected)
        return []
      const { lease, session } = reading.round
      const action = this.actionOf(reading.card, session) ?? 'what it does now is not read: no transcript of its session was found'
      const detail = `${reading.line}; the session runs on and is not stopped; ${action}`
      const raised = appendEvent(this.db, { ts, type: BOARD_ALARM, actor: EXPECTED_TIME_ACTOR, cardId: reading.card, pr: lease.pr, head: lease.head, dedupeKey: `${BOARD_ALARM}:${OVER_TIME}:${lease.taskKey}:${lease.leaseGen}`, payload: { task_key: lease.taskKey, lease_gen: lease.leaseGen, reason: OVER_TIME, detail }, legacy: false })
      return raised ? [`${BOARD_ALARM} #${reading.card} ${OVER_TIME}: ${detail}`] : []
    })
  }
}

export interface CardSession {
  card: number
  session: string
  worktree: string | null
  startedAt: string
  lastBeat: string
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function cardSessionOf(db: DatabaseSync, card: number): CardSession | null {
  const read = new BusRead(db).where({ card })
  const beats = read.where({ present: ['session'] }).slice(SESSION_HEARTBEAT, ['session'])
  const start = read.slice(CARD_STARTED, ['session', 'worktree'], 'last')[0]
  const worktree = text(start?.fields.worktree)
  const beat = beats.at(-1)
  const session = text(beat?.fields.session)
  if (beat !== undefined && session !== null && beat.ts !== null) {
    const first = beats.find(seen => seen.fields.session === session && seen.ts !== null)?.ts ?? beat.ts
    const startedAt = start?.ts != null && text(start.fields.session) === session && start.ts < first ? start.ts : first
    return { card, session, worktree, startedAt, lastBeat: beat.ts }
  }
  const started = text(start?.fields.session)
  if (start?.ts == null || started === null)
    return null
  return { card, session: started, worktree, startedAt: start.ts, lastBeat: start.ts }
}

const ENDS_OF_A_START = [CARD_SESSION_ENDED, CARD_STOPPED, CARD_ANSWERED, MERGE_DONE, CARD_CLOSED, CARD_DROPPED] as const

export interface UnendedStart {
  id: number
  card_id: number
  ts: string
  session: string | null
  worktree: string | null
  base: string | null
}

function startedByNoLaunchedSession(pid: unknown): boolean {
  return pid === undefined || pid === null
}

export function unendedStarts(db: DatabaseSync): UnendedStart[] {
  const read = new BusRead(db).where({ card: ANY })
  const lastEnd = new Map<number, number>()
  for (const type of ENDS_OF_A_START) {
    for (const end of read.slice(type, [], 'last-per-card'))
      lastEnd.set(end.card!, Math.max(lastEnd.get(end.card!) ?? 0, end.id))
  }
  return read.slice(CARD_STARTED, ['session', 'worktree', 'base', 'pid'], 'last-per-card')
    .filter(start => start.ts !== null && startedByNoLaunchedSession(start.fields.pid) && (lastEnd.get(start.card!) ?? 0) < start.id)
    .map(start => ({ id: start.id, card_id: start.card!, ts: start.ts!, session: text(start.fields.session), worktree: text(start.fields.worktree), base: text(start.fields.base) }))
}

export function firstPushAfter(db: DatabaseSync, start: UnendedStart): { pr: number | null, head: string } | null {
  const after = new BusRead(db).where({ card: start.card_id, from: start.id + 1 })
  const push = [...after.slice(PR_OPENED, []), ...after.slice(PR_OBSERVED, [])]
    .filter(seen => seen.head !== null && seen.head !== start.base)
    .sort((left, right) => left.id - right.id)[0]
  return push === undefined ? null : { pr: push.pr, head: push.head! }
}

export function firstReleaseAfter(db: DatabaseSync, start: UnendedStart): number | null {
  return new BusRead(db).where({ card: start.card_id, from: start.id + 1 }).slice(CARD_RELEASED, [])[0]?.id ?? null
}
