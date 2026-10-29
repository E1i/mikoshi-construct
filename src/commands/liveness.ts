import { existsSync } from 'node:fs'
import { WINDOW_HEARTBEAT } from '../../scripts/core/events.js'
import { withReadOnlyBus } from './cost/bus.js'

export const WINDOW_SILENT_MS = 20 * 60_000

export type FactoryState = 'live' | 'offline'

export interface FactoryLiveness {
  state: FactoryState
  lastBeat: string | null
}

const EVENTS_TABLE = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`
const NEWEST_WINDOW_BEAT = `SELECT max(ts) AS ts FROM events WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0`

function newestWindowBeat(busFile: string): string | null {
  if (!existsSync(busFile))
    return null
  return withReadOnlyBus(busFile, (db) => {
    if (db.prepare(EVENTS_TABLE).get() === undefined)
      return null
    return (db.prepare(NEWEST_WINDOW_BEAT).get() as { ts: string | null }).ts
  })
}

export function factoryLiveness(busFile: string, nowMs: number): FactoryLiveness {
  const lastBeat = newestWindowBeat(busFile)
  const fresh = lastBeat !== null && nowMs - Date.parse(lastBeat) <= WINDOW_SILENT_MS
  return { state: fresh ? 'live' : 'offline', lastBeat }
}
