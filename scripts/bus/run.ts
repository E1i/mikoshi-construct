import type { DatabaseSync } from 'node:sqlite'
import type { Poll } from './netwatch.js'
import type { Derived } from './queue.js'
import type { ReduceCount } from './reducer.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { ghApi } from './github.js'
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

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

export class BusTick {
  constructor(private readonly db: DatabaseSync, private readonly netWatch: NetWatch, private readonly clock: () => Date) {}

  run(): Tick | null {
    const poll = this.netWatch.poll()
    if (poll === null)
      return null
    if (poll.kind !== 'ticked')
      return { poll, reduced: null, derived: null }
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
  const busTick = new BusTick(db, new NetWatch(db, ghApi(process.cwd()), clock), clock)
  console.log(`${PREFIX}${busPath}, shadow mode: NetWatch, the reducer and the review queue every ${TICK_MS / 1000} s; no workers`)
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
