import type { DatabaseSync } from 'node:sqlite'
import type { GitHub } from './github.js'
import type { Poll } from './netwatch.js'
import type { GitHubPost } from './pr-status.js'
import type { Derived } from './queue.js'
import type { ReduceCount } from './reducer.js'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultDecisions } from '../decisions/read.js'
import { boardProjection } from './board-page.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { decisionsIntake } from './decisions-import.js'
import { ghApi } from './github.js'
import { CHECK_MS, NetWatch, pollLine, TICK_MS } from './netwatch.js'
import { ghApiPost, setStepStatuses, STATUS_CONTEXT, statusLine } from './pr-status.js'
import { deriveQueues } from './queue.js'
import { reduce, REDUCED } from './reducer.js'
import { stampLogOutput } from './stamp.js'
import { realRequestTools } from './window-request-tools.js'
import { WINDOW_REQUEST, WindowRequests } from './window-requests.js'

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
    this.requests()
    const ts = this.clock().toISOString()
    const through = lastEventId(this.db)
    const reduced = reduce(this.db)
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

export interface ComposedTick {
  busTick: BusTick
  boardFile: string
}

export function composeBusTick(db: DatabaseSync, busPath: string, gitHub: GitHub, post: GitHubPost, clock: () => Date, home: string): ComposedTick {
  const board = boardProjection(db, busPath)
  const requests = new WindowRequests(db, clock, realRequestTools(db, process.cwd(), process.env, home))
  const answer = (): void => {
    for (const outcome of requests.run())
      console.log(`${PREFIX}${WINDOW_REQUEST} ${outcome.request} ${outcome.kind}: ${outcome.detail}`)
  }
  const statuses = (): void => {
    try {
      for (const status of setStepStatuses(db, post, clock))
        console.log(statusLine(status))
    }
    catch (error) {
      console.log(error instanceof Error ? error.message : String(error))
    }
  }
  return { busTick: new BusTick(db, new NetWatch(db, gitHub, clock), clock, decisionsIntake(db, defaultDecisions(home), clock), board.project, answer, statuses), boardFile: board.file }
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const { busTick, boardFile } = composeBusTick(db, busPath, ghApi(process.cwd()), ghApiPost(process.cwd()), () => new Date(), os.homedir())
  console.log(`${PREFIX}${busPath}, shadow mode: NetWatch, the owner decisions import, the window requests, the reducer, the queues, the ${STATUS_CONTEXT} status check on each PR head and ${boardFile} every ${TICK_MS / 1000} s; no workers`)
  try {
    for (;;) {
      const tick = busTick.run()
      if (tick !== null)
        console.log(tickLines(tick).join('\n'))
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
