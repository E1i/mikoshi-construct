import type { DatabaseSync } from 'node:sqlite'
import type { WindowMode } from '../ports/session.js'
import type { Status } from './loop.js'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../core/db.js'
import { WINDOW_HEARTBEAT } from '../core/events.js'
import { sessionHandoffOf } from './handoff-write.js'
import { PREFIX } from './loop.js'
import { cardTreeHomes, handoffStatusOf, tabWindowIn } from './tab.js'
import { WINDOW_BEAT_MS, windowSessionOf } from './window-heartbeat.js'

export const NOT_A_WINDOW = 'turn-watch: not a window session; no watch is required'
export const NO_LIVE_WATCH = `turn-watch: this window session has no window.heartbeat newer than ${WINDOW_BEAT_MS / 60_000} minutes; start pnpm miko:watch before ending the turn`
export const LIVE_WATCH = 'turn-watch: a live pnpm miko:watch beats for this window session'
export const TAB_CONTINUE = 'turn-watch: the handoff of this tab window ends STATUS: CONTINUE; run pnpm miko:watch --once and take the next move in this session'
export const TAB_STOPS = 'turn-watch: the handoff of this tab window ends neither STATUS: CONTINUE nor STATUS: OWNER; the turn ends'
export const OWNER_QUESTION_WAITS = `turn-watch: the handoff of this tab window ends STATUS: OWNER and no window.heartbeat is newer than ${WINDOW_BEAT_MS / 60_000} minutes; the owner question is an owner wait on the board, not a turn end: run pnpm miko:watch --once and settle every other card while it waits`

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
  mode: WindowMode
  status: () => Status | null
  lastBeat: (session: string) => string | null
  now: () => number
  err: (line: string) => void
}

function liveWatch(deps: TurnWatchDeps, session: string): boolean {
  return watchIsLive(deps.lastBeat(session), deps.now())
}

function tabTurn(deps: TurnWatchDeps, session: string): number {
  const status = deps.status()
  if (status === 'CONTINUE') {
    deps.err(TAB_CONTINUE)
    return 1
  }
  if (status !== 'OWNER') {
    deps.err(TAB_STOPS)
    return 0
  }
  if (!liveWatch(deps, session)) {
    deps.err(OWNER_QUESTION_WAITS)
    return 1
  }
  deps.err(LIVE_WATCH)
  return 0
}

export function runTurnWatch(deps: TurnWatchDeps): number {
  if (deps.session === null) {
    deps.err(NOT_A_WINDOW)
    return 0
  }
  if (deps.mode === 'tab')
    return tabTurn(deps, deps.session)
  if (!liveWatch(deps, deps.session)) {
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

export function realTurnWatchDeps(env: NodeJS.ProcessEnv, dir: string = process.cwd()): TurnWatchDeps {
  const tab = tabWindowIn(env, dir, cardTreeHomes(env, defaultBusPath()))
  const handoff = sessionHandoffOf(env, os.homedir())
  return {
    session: tab?.session ?? windowSessionOf(env),
    mode: tab === null ? 'loop' : 'tab',
    status: () => handoffStatusOf(handoff),
    lastBeat: busBeat(defaultBusPath()),
    now: () => Date.now(),
    err: line => console.error(`${PREFIX}${line}`),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runTurnWatch(realTurnWatchDeps(process.env))
