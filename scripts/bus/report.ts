import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_FOLDED_ON_APPEND } from './card-automaton.js'
import { CHAIN_OBSERVED } from './chain.js'
import { defaultBusPath, openBus } from './db.js'
import { LEASE_FOLDS } from './lease.js'
import { TASK_ENQUEUED, TASK_FOLDS, TASK_SUPERSEDED } from './queue.js'
import { INCREMENTAL_PROJECTIONS, PROJECTION_KEYS, projectionDump, reduce, REDUCED, reducedThrough } from './reducer.js'
import { REJECTED } from './rejection.js'
import { watermarkOf } from './watermark.js'

export const PREFIX = '[bus:report] '

export const EXIT_CRITERIA = {
  prs: 'prs projection',
  latency: 'review latency',
  superseded: 'superseded old-head tasks',
  lag: 'projection lag',
  rejected: 'reducer.rejected',
  replay: 'replay byte-diff',
} as const

const ALL_EVENT_COLUMNS = 'id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy'

interface Row {
  id: number
  card_id: number | null
  pr: number | null
  head: string | null
  payload: string
}

class Period {
  constructor(private readonly db: DatabaseSync, private readonly since: string) {}

  events(type: string): Row[] {
    return this.db.prepare('SELECT id, card_id, pr, head, payload FROM events WHERE type = ? AND legacy = 0 AND ts >= ? ORDER BY id').all(type, this.since) as unknown as Row[]
  }

  ticksBetween(fromId: number, toId: number): number {
    return Number((this.db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'netwatch.tick' AND id > ? AND id < ?`).get(fromId, toId) as { n: number }).n)
  }
}

function payload(row: Row): Record<string, unknown> {
  return JSON.parse(row.payload) as Record<string, unknown>
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const PR_STATES = ['open', 'merged', 'closed'] as const

function prsLine(db: DatabaseSync, period: Period): string {
  const projected = (db.prepare('SELECT state FROM prs').all() as { state: string }[]).map(row => row.state)
  const counts = PR_STATES.map(state => `${state} ${projected.filter(each => each === state).length}`).join(', ')
  const closings = period.events('pr.closed').map(row => payload(row).merged === true)
  return `${EXIT_CRITERIA.prs}: ${projected.length} in the projection (${counts}); `
    + `transitions seen: merged ${closings.filter(Boolean).length}, closed ${closings.filter(merged => !merged).length}`
}

function eligible(row: Row): boolean {
  const observed = payload(row)
  return row.card_id !== null && observed.ci === 'green' && observed.verdict_on_head === undefined
}

function latencyLine(period: Period): string {
  const queued = new Map(period.events(TASK_ENQUEUED).filter(row => payload(row).queue === 'review').map(row => [`${row.pr}:${row.head}`, row.id]))
  const firstEligible = new Map<string, Row>()
  for (const row of period.events('pr.observed')) {
    const head = `${row.pr}:${row.head}`
    if (!firstEligible.has(head) && eligible(row))
      firstEligible.set(head, row)
  }
  const latencies: number[] = []
  const waiting: string[] = []
  for (const [head, row] of firstEligible) {
    const queuedId = queued.get(head)
    if (queuedId === undefined)
      waiting.push(`#${row.pr}@${row.head!.slice(0, 7)}`)
    else
      latencies.push(period.ticksBetween(row.id, queuedId))
  }
  const summary = latencies.length === 0 ? 'no head queued' : `${latencies.length} heads queued, median ${median(latencies)} ticks, max ${Math.max(...latencies)} ticks`
  return `${EXIT_CRITERIA.latency}: ${summary}; green with no verdict and not queued: ${waiting.join(', ') || 'none'}`
}

function supersededLine(db: DatabaseSync, period: Period): string {
  const stale = db.prepare(`SELECT tasks.task_key FROM tasks JOIN prs ON prs.pr = tasks.pr WHERE tasks.state = 'queued' AND tasks.head != prs.head ORDER BY tasks.task_key`).all().map(row => String(row.task_key))
  return `${EXIT_CRITERIA.superseded}: ${period.events(TASK_SUPERSEDED).length} superseded; still queued on an old head: ${stale.join(', ') || 'none'}`
}

function lagLine(period: Period): string {
  const reductions = period.events(REDUCED).map(row => ({ id: row.id, through: Number(payload(row).through_event_id) }))
  const ticks = period.events('netwatch.tick').filter(row => Number(payload(row).written) > 0)
  const lags: number[] = []
  let unreduced = 0
  for (const tick of ticks) {
    const covering = reductions.find(reduction => reduction.through >= tick.id)
    if (covering === undefined)
      unreduced += 1
    else
      lags.push(period.ticksBetween(tick.id, covering.id))
  }
  const summary = lags.length === 0 ? 'no tick reduced' : `max ${Math.max(...lags)} ticks over ${lags.length} ticks that wrote events`
  return `${EXIT_CRITERIA.lag}: ${summary}; not reduced yet: ${unreduced}`
}

function rejectedLine(period: Period): string {
  const byType = new Map<string, number>()
  const rejections = period.events(REJECTED)
  for (const row of rejections) {
    const type = String(payload(row).type)
    byType.set(type, (byType.get(type) ?? 0) + 1)
  }
  const detail = [...byType].map(([type, count]) => `${type} ${count}`).join(', ')
  return `${EXIT_CRITERIA.rejected}: ${rejections.length}${detail === '' ? '' : ` (${detail})`}`
}

export const FOLDED_ON_APPEND: ReadonlySet<string> = new Set([...Object.keys(TASK_FOLDS), ...Object.keys(LEASE_FOLDS), ...CARD_FOLDED_ON_APPEND, CHAIN_OBSERVED])

type ProjectionRow = Record<string, unknown>
type Projection = Record<string, ProjectionRow[]>

const NO_REDUCE_MARKER = 0

function replayCutOff(db: DatabaseSync): number {
  const through = reducedThrough(db)
  return through === NO_REDUCE_MARKER ? Number.POSITIVE_INFINITY : through
}

function incrementalCutOffs(db: DatabaseSync, through: number): Map<string, number> {
  return new Map(INCREMENTAL_PROJECTIONS.flatMap((projection) => {
    const watermark = Math.max(watermarkOf(db, projection.table), through)
    return Object.keys(projection.folds).map(type => [type, watermark] as const)
  }))
}

function rowsByKey(table: string, rows: ProjectionRow[]): Map<string, ProjectionRow> {
  const key = PROJECTION_KEYS[table]
  return new Map(rows.map(row => [key === undefined ? JSON.stringify(row) : String(row[key]), row]))
}

function shown(value: unknown): string {
  return JSON.stringify(value) ?? 'absent'
}

function fieldDifferences(live: ProjectionRow, replayed: ProjectionRow): string[] {
  const fields = [...new Set([...Object.keys(live), ...Object.keys(replayed)])]
  return fields.filter(field => shown(live[field]) !== shown(replayed[field])).map(field => `${field} live ${shown(live[field])}, replay ${shown(replayed[field])}`)
}

export interface ReplayDifference {
  table: string | null
  line: string
}

function rowDifferences(live: Projection, replayed: Projection): ReplayDifference[] {
  const differences: ReplayDifference[] = []
  for (const table of [...new Set([...Object.keys(live), ...Object.keys(replayed)])]) {
    const liveRows = rowsByKey(table, live[table] ?? [])
    const replayRows = rowsByKey(table, replayed[table] ?? [])
    for (const [key, row] of liveRows) {
      const other = replayRows.get(key)
      if (other === undefined)
        differences.push({ table, line: `${table} ${key}: live only` })
      else if (fieldDifferences(row, other).length > 0)
        differences.push({ table, line: `${table} ${key}: ${fieldDifferences(row, other).join('; ')}` })
    }
    for (const key of replayRows.keys()) {
      if (!liveRows.has(key))
        differences.push({ table, line: `${table} ${key}: replay only` })
    }
  }
  return differences
}

interface Snapshot {
  liveDump: string
  through: number
  incremental: Map<string, number>
  events: Record<string, SQLOutputValue>[]
}

function oneSnapshot(db: DatabaseSync): Snapshot {
  db.exec('BEGIN')
  try {
    const liveDump = projectionDump(db)
    const through = replayCutOff(db)
    const incremental = incrementalCutOffs(db, through)
    const events = db.prepare(`SELECT ${ALL_EVENT_COLUMNS} FROM events ORDER BY id`).all()
    return { liveDump, through, incremental, events }
  }
  finally {
    db.exec('COMMIT')
  }
}

export function replayDifferences(db: DatabaseSync): { live: number, differences: ReplayDifference[] } {
  const { liveDump, through, incremental, events } = oneSnapshot(db)
  const live = Buffer.from(liveDump)
  const replay = openBus(':memory:')
  try {
    const insert = replay.prepare(`INSERT INTO events (${ALL_EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of events) {
      if (Number(row.id) <= (incremental.get(String(row.type)) ?? through) || FOLDED_ON_APPEND.has(String(row.type)))
        insert.run(row.id, row.ts, row.type, row.actor, row.card_id, row.pr, row.head, row.dedupe_key, row.payload, row.legacy)
    }
    reduce(replay)
    const replayDump = projectionDump(replay)
    const replayed = Buffer.from(replayDump)
    if (replayed.equals(live))
      return { live: live.length, differences: [] }
    const differences = rowDifferences(JSON.parse(liveDump) as Projection, JSON.parse(replayDump) as Projection)
    if (differences.length > 0)
      return { live: live.length, differences }
    const at = [...live].findIndex((byte, index) => byte !== replayed[index])
    return { live: live.length, differences: [{ table: null, line: `differs from byte ${at === -1 ? Math.min(live.length, replayed.length) : at} (live ${live.length} bytes, replay ${replayed.length})` }] }
  }
  finally {
    replay.close()
  }
}

function replayLine(db: DatabaseSync): string {
  const { live, differences } = replayDifferences(db)
  return `${EXIT_CRITERIA.replay}: ${differences.length === 0 ? `none, ${live} bytes identical` : differences.map(difference => difference.line).join(' | ')}`
}

export interface ShadowReading {
  problems: string[]
  foreign: string[]
}

export type ReadSet = ReadonlySet<string>

function readBy(readSet: ReadSet | undefined, difference: ReplayDifference): boolean {
  return readSet === undefined || difference.table === null || readSet.has(difference.table)
}

export function shadowReading(db: DatabaseSync, readSet?: ReadSet): ShadowReading {
  const { differences } = replayDifferences(db)
  const replayLines = (read: boolean): string[] => differences.filter(difference => readBy(readSet, difference) === read).map(difference => `${EXIT_CRITERIA.replay}: ${difference.line}`)
  return { problems: replayLines(true), foreign: replayLines(false) }
}

export function shadowReport(db: DatabaseSync, since: string): string[] {
  const period = new Period(db, since)
  const ticks = period.events('netwatch.tick').length
  const skipped = period.events('netwatch.skipped').length
  return [
    `${since === '' ? 'over the whole log' : `since ${since}`}: ${ticks} ticks, ${skipped} skipped polls`,
    prsLine(db, period),
    latencyLine(period),
    supersededLine(db, period),
    lagLine(period),
    rejectedLine(period),
    replayLine(db),
  ].map(line => `${PREFIX}${line}`)
}

function sinceOf(argv: string[]): string {
  const index = argv.indexOf('--since')
  return index === -1 ? '' : argv[index + 1] ?? ''
}

function main(): number {
  const db = openBus(defaultBusPath())
  try {
    console.log(shadowReport(db, sinceOf(process.argv)).join('\n'))
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
