import type { DatabaseSync } from 'node:sqlite'
import type { Derived } from '../core/queue.js'
import type { ReduceCount } from '../core/reducer.js'
import type { GitHub } from '../ports/github.js'
import type { Poll } from '../ports/netwatch.js'
import type { GitHubPost } from '../ports/pr-status.js'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { boardProjection } from '../cli/board-page.js'
import { decisionsFileOf } from '../core/bus-path.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { REDUCED, WINDOW_REQUEST } from '../core/events.js'
import { DATABASE_LOCKED, isDatabaseLocked } from '../core/node.js'
import { deriveQueues } from '../core/queue.js'
import { closeWaitsOfEndedCards, reduce } from '../core/reducer.js'
import { ownerChannelOfBus } from '../owner/channel.js'
import { decisionsIntake } from '../policy/decisions-import.js'
import { ghApi } from '../ports/github.js'
import { CHECK_MS, NetWatch, pollLine, TICK_MS } from '../ports/netwatch.js'
import { ghApiPost, setStepStatuses, STATUS_CONTEXT, STATUS_OFF_FILE, statusesSwitchedOff, statusFailureLine, statusLine } from '../ports/pr-status.js'
import { realRequestTools } from '../window/window-request-tools.js'
import { WindowRequests } from '../window/window-requests.js'
import { stampLogOutput } from './stamp.js'

export const PREFIX = '[bus:run] '

export interface Tick {
  poll: Poll
  reduced: ReduceCount | null
  derived: Derived | null
}

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

export class BusTick {
  constructor(private readonly db: DatabaseSync, private readonly netWatch: NetWatch, private readonly clock: () => Date, private readonly intake: () => void = () => {}, private readonly project: (now: Date) => void = () => {}, private readonly requests: () => void = () => {}, private readonly statuses: () => void = () => {}) {}

  run(): Tick | null {
    const poll = this.netWatch.poll()
    if (poll === null)
      return null
    if (poll.kind !== 'ticked')
      return { poll, reduced: null, derived: null }
    this.intake()
    const beforeRequests = reduce(this.db)
    this.requests()
    const ts = this.clock().toISOString()
    const through = lastEventId(this.db)
    const afterRequests = reduce(this.db)
    const reduced = { applied: beforeRequests.applied + afterRequests.applied, rejected: beforeRequests.rejected + afterRequests.rejected }
    appendEvent(this.db, { ts, type: REDUCED, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: `${REDUCED}:${ts}`, payload: { through_event_id: through, ...reduced }, legacy: false })
    const derived = deriveQueues(this.db, ts)
    this.statuses()
    this.project(this.clock())
    return { poll, reduced, derived }
  }
}

export function tickLines(tick: Tick): string[] {
  const lines = [pollLine(tick.poll)]
  if (tick.reduced !== null)
    lines.push(`${PREFIX}reduced: applied ${tick.reduced.applied}, rejected ${tick.reduced.rejected}`)
  if (tick.derived !== null && tick.derived.superseded.length + tick.derived.queued.length > 0)
    lines.push(`${PREFIX}queues: superseded ${tick.derived.superseded.join(', ') || '—'}; queued ${tick.derived.queued.join(', ') || '—'}`)
  return lines
}

export function tickOrLocked(busTick: BusTick): string[] {
  try {
    const tick = busTick.run()
    return tick === null ? [] : tickLines(tick)
  }
  catch (error) {
    if (!isDatabaseLocked(error))
      throw error
    return [`${PREFIX}the tick hit ${DATABASE_LOCKED}; it is retried in ${CHECK_MS / 1000} s, and bus:run stays up`]
  }
}

export interface ComposedTick {
  busTick: BusTick
  boardFile: string
  boardDataFile: string
}

export function composeBusTick(db: DatabaseSync, busPath: string, gitHub: GitHub, post: GitHubPost, clock: () => Date, home: string): ComposedTick {
  const board = boardProjection(db, busPath, TICK_MS)
  const requests = new WindowRequests(db, clock, realRequestTools(db, busPath, process.cwd(), process.env), ownerChannelOfBus(home, busPath))
  const answer = (): void => {
    for (const outcome of requests.run())
      console.log(`${PREFIX}${WINDOW_REQUEST} ${outcome.request} ${outcome.kind}: ${outcome.detail}`)
  }
  const statuses = (): void => {
    if (statusesSwitchedOff(busPath))
      return
    try {
      for (const status of setStepStatuses(db, post, clock))
        console.log(statusLine(status))
    }
    catch (error) {
      console.log(statusFailureLine(error))
    }
  }
  return { busTick: new BusTick(db, new NetWatch(db, gitHub, clock), clock, decisionsIntake(db, decisionsFileOf(busPath), clock), board.project, answer, statuses), boardFile: board.file, boardDataFile: board.dataFile }
}

export function startBus(db: DatabaseSync, clock: () => Date): string[] {
  return inTransaction(db, () => closeWaitsOfEndedCards(db, clock().toISOString()))
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const closed = startBus(db, () => new Date())
  if (closed.length > 0)
    console.log(`${PREFIX}closed the owner waits of ended cards: ${closed.join(', ')}`)
  const { busTick, boardFile, boardDataFile } = composeBusTick(db, busPath, ghApi(process.cwd()), ghApiPost(process.cwd()), () => new Date(), os.homedir())
  console.log(`${PREFIX}${busPath}, shadow mode: NetWatch, the owner decisions import, the window requests, the reducer, the queues, the ${STATUS_CONTEXT} status check on each open PR head unless ${STATUS_OFF_FILE} sits beside it, and ${boardFile} with ${boardDataFile} every ${TICK_MS / 1000} s; no workers`)
  try {
    for (;;) {
      const lines = tickOrLocked(busTick)
      if (lines.length > 0)
        console.log(lines.join('\n'))
      await sleep(CHECK_MS)
    }
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
