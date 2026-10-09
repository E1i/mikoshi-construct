import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { GitHub } from './github.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { appendEvent, defaultBusPath, inTransaction, openBus } from './db.js'
import { ghApi } from './github.js'
import { Meter, RateLimited } from './meter.js'
import { NETWATCH, observationsOf } from './observations.js'
import { takeSnapshot } from './snapshot.js'

export const PREFIX = '[bus:netwatch] '
export const TICK_MS = 60_000
export const WAKE_GAP_MS = 3 * TICK_MS
export const CHECK_MS = 5_000

export type PollReason = 'start' | 'interval' | 'wake'

export type Poll
  = | { kind: 'ticked', reason: PollReason, calls: number, remaining: number | null, written: number, unsettled: number[] }
    | { kind: 'skipped', reason: PollReason, cause: 'retry-after' | 'rate-limited' | 'failed', calls: number, until?: string, detail?: string }

const KNOWN_OPEN_PRS = `
  SELECT pr FROM prs WHERE pr NOT IN (SELECT pr FROM events WHERE type = 'pr.closed' AND pr IS NOT NULL)
  UNION
  SELECT pr FROM events WHERE type = 'pr.observed' AND pr IS NOT NULL
    AND pr NOT IN (SELECT pr FROM events WHERE type = 'pr.closed' AND pr IS NOT NULL)
  ORDER BY pr
`

const LAST_MAIN = `SELECT payload FROM events WHERE type = 'main.advanced' ORDER BY id DESC LIMIT 1`

export function knownOpenPrs(db: DatabaseSync): number[] {
  return db.prepare(KNOWN_OPEN_PRS).all().map(row => Number(row.pr))
}

export function lastMain(db: DatabaseSync): string | null {
  const row = db.prepare(LAST_MAIN).get()
  if (row === undefined)
    return null
  const sha = (JSON.parse(String(row.payload)) as { sha?: unknown }).sha
  return typeof sha === 'string' ? sha : null
}

function record(ts: string, type: 'netwatch.tick' | 'netwatch.skipped', payload: object): BusEvent {
  return { ts, type, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: `${type}:${ts}`, payload, legacy: false }
}

export class NetWatch {
  private lastPollAt: number | null = null
  private blockedUntil = 0

  constructor(private readonly db: DatabaseSync, private readonly gitHub: GitHub, private readonly clock: () => Date) {}

  dueReason(nowMs: number): PollReason | null {
    if (this.lastPollAt === null)
      return 'start'
    const gap = nowMs - this.lastPollAt
    if (gap > WAKE_GAP_MS)
      return 'wake'
    return gap >= TICK_MS ? 'interval' : null
  }

  poll(): Poll | null {
    const now = this.clock()
    const nowMs = now.getTime()
    const reason = this.dueReason(nowMs)
    if (reason === null)
      return null
    const gapSeconds = this.lastPollAt === null ? null : Math.round((nowMs - this.lastPollAt) / 1000)
    this.lastPollAt = nowMs
    const ts = now.toISOString()
    if (nowMs < this.blockedUntil)
      return this.skipped(ts, { kind: 'skipped', reason, cause: 'retry-after', calls: 0, until: new Date(this.blockedUntil).toISOString() })
    const meter = new Meter(this.gitHub, () => this.clock().getTime())
    try {
      const snapshot = takeSnapshot(meter, knownOpenPrs(this.db), lastMain(this.db))
      const poll: Poll = { kind: 'ticked', reason, calls: meter.calls, remaining: meter.remaining, written: 0, unsettled: snapshot.unsettled }
      inTransaction(this.db, () => {
        for (const event of observationsOf(ts, snapshot)) {
          if (appendEvent(this.db, event))
            poll.written += 1
        }
        appendEvent(this.db, record(ts, 'netwatch.tick', { reason, gap_s: gapSeconds, calls: poll.calls, rate_remaining: poll.remaining, written: poll.written, unsettled: poll.unsettled }))
      })
      return poll
    }
    catch (error) {
      if (error instanceof RateLimited) {
        this.blockedUntil = nowMs + error.retryAfterSeconds * 1000
        return this.skipped(ts, { kind: 'skipped', reason, cause: 'rate-limited', calls: meter.calls, until: new Date(this.blockedUntil).toISOString(), detail: error.message })
      }
      return this.skipped(ts, { kind: 'skipped', reason, cause: 'failed', calls: meter.calls, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  private skipped(ts: string, poll: Extract<Poll, { kind: 'skipped' }>): Poll {
    appendEvent(this.db, record(ts, 'netwatch.skipped', { reason: poll.reason, cause: poll.cause, calls: poll.calls, until: poll.until ?? null, detail: poll.detail ?? null }))
    return poll
  }
}

export function pollLine(poll: Poll): string {
  if (poll.kind === 'ticked')
    return `${PREFIX}tick (${poll.reason}): ${poll.calls} calls, ${poll.remaining ?? '?'} remaining, ${poll.written} new events${poll.unsettled.length === 0 ? '' : `, mergeable not settled on #${poll.unsettled.join(', #')}`}`
  return `${PREFIX}skipped (${poll.reason}, ${poll.cause}): ${poll.calls} calls${poll.until === undefined ? '' : `, until ${poll.until}`}${poll.detail === undefined ? '' : `: ${poll.detail}`}`
}

async function main(): Promise<number> {
  const once = process.argv.includes('--once')
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const netWatch = new NetWatch(db, ghApi(process.cwd()), () => new Date())
  console.log(`${PREFIX}${busPath}, a tick every ${TICK_MS / 1000} s${once ? ', once' : ''}`)
  try {
    for (;;) {
      const poll = netWatch.poll()
      if (poll !== null)
        console.log(pollLine(poll))
      if (once)
        return poll?.kind === 'ticked' ? 0 : 1
      await sleep(CHECK_MS)
    }
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
