import type { DatabaseSync } from 'node:sqlite'
import type { SessionGauges } from '../miko/eddies-measure.js'
import type { WindowMode } from '../ports/session.js'
import type { SessionMeasure } from './heartbeat.js'
import { PROCESS_ENDED, PROCESS_HEARTBEAT, WINDOW_HEARTBEAT } from '../core/events.js'
import { windowModeOf } from '../ports/session.js'
import { appendEvent, openBus } from './db.js'
import { measureSession } from './heartbeat.js'
import { beatsLive } from './liveness-sites.js'
import { WINDOW_ACTOR } from './window-requests.js'

export const WINDOW_BEAT_MS = 5 * 60_000
export const LOOP_PROCESS = 'miko:'

const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SESSION_ID = /^[^:\s]+$/

const LAST_LOOP_BEATS = `
  SELECT beats.name, beats.ts FROM (
    SELECT json_extract(payload, '$.process') AS name, max(ts) AS ts FROM events
    WHERE type = '${PROCESS_HEARTBEAT}' AND legacy = 0 AND json_valid(payload) AND json_extract(payload, '$.process') LIKE '${LOOP_PROCESS}%'
    GROUP BY name
  ) AS beats
  WHERE NOT EXISTS (
    SELECT 1 FROM events AS ended
    WHERE ended.type = '${PROCESS_ENDED}' AND json_valid(ended.payload) AND json_extract(ended.payload, '$.process') = beats.name AND ended.ts >= beats.ts
  )
  ORDER BY beats.ts DESC
`

const LAST_WINDOW_BEAT = `SELECT max(ts) AS ts FROM events WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0 AND ts > ?`

export interface WindowSession {
  session: string
  mode: WindowMode
}

export function windowOf(env: NodeJS.ProcessEnv): WindowSession | null {
  const session = env[SESSION_VARIABLE]?.trim()
  const mode = windowModeOf(env)
  return mode !== null && session !== undefined && SESSION_ID.test(session) ? { session, mode } : null
}

export function windowSessionOf(env: NodeJS.ProcessEnv): string | null {
  const window = windowOf(env)
  return window?.mode === 'loop' ? window.session : null
}

export type WindowBeatFields = SessionGauges & { mode?: WindowMode }

export function recordWindowHeartbeat(db: DatabaseSync, ts: string, session: string, fields: WindowBeatFields = {}): boolean {
  return appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: `${WINDOW_ACTOR}${session}`, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:${session}:${ts}`, payload: { session, ...fields }, legacy: false })
}

export function windowBeat(bus: string, window: WindowSession | null, now: () => number, measure: SessionMeasure = measureSession): () => void {
  let last = Number.NEGATIVE_INFINITY
  return () => {
    const at = now()
    if (window === null || at - last < WINDOW_BEAT_MS)
      return
    last = at
    const db = openBus(bus)
    try {
      recordWindowHeartbeat(db, new Date(at).toISOString(), window.session, { mode: window.mode, ...measure(window.session) })
    }
    finally {
      db.close()
    }
  }
}

export function lastLoopBeats(db: DatabaseSync): { name: string, ts: string }[] {
  return db.prepare(LAST_LOOP_BEATS).all() as { name: string, ts: string }[]
}

export function windowLive(db: DatabaseSync, nowMs: number, windowEnded: string | null): boolean {
  const lastBeat = (db.prepare(LAST_WINDOW_BEAT).get(windowEnded ?? '') as { ts: string | null }).ts
  return (lastBeat !== null && beatsLive(lastBeat, nowMs)) || lastLoopBeats(db).some(beat => beatsLive(beat.ts, nowMs))
}
