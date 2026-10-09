import type { DatabaseSync } from 'node:sqlite'
import type { GitHub } from './github.js'
import { Buffer } from 'node:buffer'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from './db.js'
import { ghApi } from './github.js'
import { Meter } from './meter.js'
import { TASK_ENQUEUED, TASK_SUPERSEDED } from './queue.js'
import { projectionDump, reduce, REJECTED } from './reducer.js'
import { REDUCED } from './run.js'

export const PREFIX = '[bus:report] '

export const EXIT_CRITERIA = {
  prs: 'prs vs GitHub',
  latency: 'review latency',
  superseded: 'superseded old-head tasks',
  lag: 'projection lag',
  rejected: 'reducer.rejected',
  replay: 'replay byte-diff',
} as const

const REPO = 'repos/{owner}/{repo}'
const ALL_EVENT_COLUMNS = 'id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy'

interface Row {
  id: number
  card_id: number | null
  pr: number | null
  head: string | null
  payload: string
}

type GitHubState = 'open' | 'merged' | 'closed'

interface Pull {
  number: number
  state: string
  merged?: boolean
  head?: { sha?: string }
}

interface GitHubPull {
  state: GitHubState
  head: string | null
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

function gitHubPullOf(pull: Pull): GitHubPull {
  return { state: pull.state === 'open' ? 'open' : pull.merged === true ? 'merged' : 'closed', head: pull.head?.sha ?? null }
}

function gitHubPulls(gitHub: GitHub, projected: number[], nowMs: () => number): Map<number, GitHubPull> {
  const meter = new Meter(gitHub, nowMs)
  const pulls = new Map<number, GitHubPull>()
  for (const pull of meter.get(`${REPO}/pulls?state=open&per_page=100`) as Pull[])
    pulls.set(pull.number, gitHubPullOf(pull))
  for (const pr of projected.filter(each => !pulls.has(each)))
    pulls.set(pr, gitHubPullOf(meter.get(`${REPO}/pulls/${pr}`) as Pull))
  return pulls
}

interface Comparison {
  agree: Record<GitHubState, number>
  mismatches: string[]
  missing: string[]
  headMismatches: string[]
}

function compared(db: DatabaseSync, gitHub: GitHub, nowMs: () => number): Comparison {
  const projected = db.prepare('SELECT pr, state, head FROM prs ORDER BY pr').all() as { pr: number, state: string, head: string | null }[]
  const pulls = gitHubPulls(gitHub, projected.map(row => row.pr), nowMs)
  const comparison: Comparison = { agree: { open: 0, merged: 0, closed: 0 }, mismatches: [], missing: [], headMismatches: [] }
  for (const row of projected) {
    const actual = pulls.get(row.pr)!
    if (actual.state === row.state)
      comparison.agree[actual.state] += 1
    else
      comparison.mismatches.push(`#${row.pr} ${row.state} here, ${actual.state} on GitHub`)
    if (actual.state === 'open' && row.state === 'open' && actual.head !== row.head)
      comparison.headMismatches.push(`#${row.pr} at ${row.head ?? 'no head'} here, ${actual.head ?? 'no head'} on GitHub`)
  }
  comparison.missing = [...pulls].filter(([pr, pull]) => pull.state === 'open' && !projected.some(row => row.pr === pr)).map(([pr]) => `#${pr}`)
  return comparison
}

function prsLine(db: DatabaseSync, period: Period, gitHub: GitHub, nowMs: () => number): string {
  const projected = db.prepare('SELECT pr FROM prs').all()
  const { agree, mismatches, missing } = compared(db, gitHub, nowMs)
  const closings = period.events('pr.closed').map(row => payload(row).merged === true)
  return `${EXIT_CRITERIA.prs}: ${agree.open + agree.merged + agree.closed} of ${projected.length} agree (open ${agree.open}, merged ${agree.merged}, closed ${agree.closed}); `
    + `transitions seen: merged ${closings.filter(Boolean).length}, closed ${closings.filter(merged => !merged).length}; `
    + `mismatched: ${mismatches.join(', ') || 'none'}; open on GitHub, missing here: ${missing.join(', ') || 'none'}`
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

function replayDifference(db: DatabaseSync): { live: number, difference: string | null } {
  const live = Buffer.from(projectionDump(db))
  const replay = openBus(':memory:')
  try {
    const insert = replay.prepare(`INSERT INTO events (${ALL_EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of db.prepare(`SELECT ${ALL_EVENT_COLUMNS} FROM events ORDER BY id`).all())
      insert.run(row.id, row.ts, row.type, row.actor, row.card_id, row.pr, row.head, row.dedupe_key, row.payload, row.legacy)
    reduce(replay)
    const replayed = Buffer.from(projectionDump(replay))
    if (replayed.equals(live))
      return { live: live.length, difference: null }
    const at = [...live].findIndex((byte, index) => byte !== replayed[index])
    return { live: live.length, difference: `differs from byte ${at === -1 ? Math.min(live.length, replayed.length) : at} (live ${live.length} bytes, replay ${replayed.length})` }
  }
  finally {
    replay.close()
  }
}

function replayLine(db: DatabaseSync): string {
  const { live, difference } = replayDifference(db)
  return `${EXIT_CRITERIA.replay}: ${difference ?? `none, ${live} bytes identical`}`
}

export function shadowProblems(db: DatabaseSync, gitHub: GitHub, nowMs: () => number): string[] {
  const { mismatches, missing, headMismatches } = compared(db, gitHub, nowMs)
  const { difference } = replayDifference(db)
  return [
    ...mismatches.map(mismatch => `${EXIT_CRITERIA.prs}: ${mismatch}`),
    ...missing.map(pr => `${EXIT_CRITERIA.prs}: ${pr} open on GitHub, missing here`),
    ...headMismatches.map(mismatch => `${EXIT_CRITERIA.prs}: ${mismatch}`),
    ...(difference === null ? [] : [`${EXIT_CRITERIA.replay}: ${difference}`]),
  ]
}

export function shadowReport(db: DatabaseSync, gitHub: GitHub, since: string, nowMs: () => number): string[] {
  const period = new Period(db, since)
  const ticks = period.events('netwatch.tick').length
  const skipped = period.events('netwatch.skipped').length
  return [
    `${since === '' ? 'over the whole log' : `since ${since}`}: ${ticks} ticks, ${skipped} skipped polls`,
    prsLine(db, period, gitHub, nowMs),
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
    console.log(shadowReport(db, ghApi(process.cwd()), sinceOf(process.argv), () => Date.now()).join('\n'))
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
