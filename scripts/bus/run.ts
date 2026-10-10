import type { DatabaseSync } from 'node:sqlite'
import type { LaneOnDisk } from './admissions.js'
import type { Poll } from './netwatch.js'
import type { Derived } from './queue.js'
import type { ReduceCount } from './reducer.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultDecisions } from '../decisions/read.js'
import { defaultParking } from '../ghosts/handoff-check.js'
import { parkingLane } from './admissions.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { decisionsIntake } from './decisions-import.js'
import { ghApi } from './github.js'
import { importJournal, journalPath } from './import.js'
import { CHECK_MS, NetWatch, pollLine, TICK_MS } from './netwatch.js'
import { deriveQueues } from './queue.js'
import { reduce } from './reducer.js'

export const PREFIX = '[bus:run] '
export const REDUCED = 'reducer.reduced'

export interface Tick {
  poll: Poll
  reduced: ReduceCount | null
  derived: Derived | null
}

export function journalIntake(db: DatabaseSync, journal: string, laneOnDisk: LaneOnDisk, clock: () => Date): () => void {
  return () => {
    if (existsSync(journal))
      importJournal(db, readFileSync(journal, 'utf8'), laneOnDisk, clock)
  }
}

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

export class BusTick {
  constructor(private readonly db: DatabaseSync, private readonly netWatch: NetWatch, private readonly clock: () => Date, private readonly intake: () => void = () => {}) {}

  run(): Tick | null {
    const poll = this.netWatch.poll()
    if (poll === null)
      return null
    if (poll.kind !== 'ticked')
      return { poll, reduced: null, derived: null }
    this.intake()
    const ts = this.clock().toISOString()
    const through = lastEventId(this.db)
    const reduced = reduce(this.db)
    appendEvent(this.db, { ts, type: REDUCED, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: `${REDUCED}:${ts}`, payload: { through_event_id: through, ...reduced }, legacy: false })
    return { poll, reduced, derived: deriveQueues(this.db, ts) }
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

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const clock = (): Date => new Date()
  const journal = journalIntake(db, journalPath(), parkingLane(defaultParking(os.homedir())), clock)
  const decisions = decisionsIntake(db, defaultDecisions(os.homedir()), clock)
  const busTick = new BusTick(db, new NetWatch(db, ghApi(process.cwd()), clock), clock, () => {
    journal()
    decisions()
  })
  console.log(`${PREFIX}${busPath}, shadow mode: NetWatch, the journal and owner decisions import, the reducer and the queues every ${TICK_MS / 1000} s; no workers`)
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

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
