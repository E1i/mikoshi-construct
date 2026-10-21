import type { DatabaseSync } from 'node:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../bus/db.js'
import { WINDOW_BEAT_MS, windowSessionOf } from '../bus/window-heartbeat.js'
import { WINDOW_HEARTBEAT } from '../core/events.js'
import { PREFIX } from './loop.js'

export const NOT_A_WINDOW = 'turn-watch: not a window session; no watch is required'
export const NO_LIVE_WATCH = `turn-watch: this window session has no window.heartbeat newer than ${WINDOW_BEAT_MS / 60_000} minutes; start pnpm miko:watch before ending the turn`
export const LIVE_WATCH = 'turn-watch: a live pnpm miko:watch beats for this window session'

const LAST_BEAT = `SELECT ts FROM events WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0 AND json_valid(payload) AND json_extract(payload, '$.session') = ? ORDER BY id DESC LIMIT 1`

export function watchIsLive(lastBeat: string | null, now: number): boolean {
  if (lastBeat === null)
    return false
  const at = Date.parse(lastBeat)
  return Number.isFinite(at) && now - at <= WINDOW_BEAT_MS
}

export function lastWindowBeat(db: DatabaseSync, session: string): string | null {
  const row = db.prepare(LAST_BEAT).get(session) as { ts: string } | undefined
  return row?.ts ?? null
}

export interface TurnWatchDeps {
  session: string | null
  lastBeat: (session: string) => string | null
  now: () => number
  err: (line: string) => void
}

export function runTurnWatch(deps: TurnWatchDeps): number {
  if (deps.session === null) {
    deps.err(NOT_A_WINDOW)
    return 0
  }
  if (!watchIsLive(deps.lastBeat(deps.session), deps.now())) {
    deps.err(NO_LIVE_WATCH)
    return 1
  }
  deps.err(LIVE_WATCH)
  return 0
}

function busBeat(bus: string): (session: string) => string | null {
  return (session) => {
    if (!existsSync(bus))
      return null
    const db = openBus(bus)
    try {
      return lastWindowBeat(db, session)
    }
    finally {
      db.close()
    }
  }
}

export function realTurnWatchDeps(env: NodeJS.ProcessEnv): TurnWatchDeps {
  return { session: windowSessionOf(env), lastBeat: busBeat(defaultBusPath()), now: () => Date.now(), err: line => console.error(`${PREFIX}${line}`) }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runTurnWatch(realTurnWatchDeps(process.env))
