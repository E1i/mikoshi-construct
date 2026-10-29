import type { DatabaseSync } from 'node:sqlite'
import type { WindowMode } from '../ports/session.js'
import type { SessionMeasure } from '../supervisor/heartbeat.js'
import type { SessionGauges } from './eddies-measure.js'
import { appendEvent, openBus } from '../core/db.js'
import { PROCESS_ENDED, PROCESS_HEARTBEAT, WINDOW_HEARTBEAT } from '../core/events.js'
import { windowModeOf } from '../ports/session.js'
import { measureSession } from '../supervisor/heartbeat.js'
import { beatsLive } from '../supervisor/liveness-sites.js'
import { WINDOW_ACTOR } from './window-requests.js'

export const WINDOW_BEAT_MS = 5 * 60_000
export const LOOP_PROCESS = 'miko:'

const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const PROJECT_VARIABLE = 'CLAUDE_PROJECT_DIR'
const SESSION_ID = /^[^:\s]+$/
const SQLITE_BUSY = 5
const PRIMARY_RESULT_CODE = 0xFF

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

const LIVE_WINDOW_BEATS = `
  SELECT json_extract(payload, '$.session') AS session, max(ts) AS ts FROM events
  WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0 AND json_valid(payload) AND json_extract(payload, '$.root') = ? AND json_extract(payload, '$.session') != ?
  GROUP BY session
  ORDER BY ts DESC
`

export interface WindowSession {
  session: string
  mode: WindowMode
  root?: string
}

export function windowOf(env: NodeJS.ProcessEnv): WindowSession | null {
  const session = env[SESSION_VARIABLE]?.trim()
  const mode = windowModeOf(env)
  const root = env[PROJECT_VARIABLE]?.trim()
  if (mode === null || session === undefined || !SESSION_ID.test(session))
    return null
  return root === undefined || root === '' ? { session, mode } : { session, mode, root }
}

export function otherLiveWindows(db: DatabaseSync, window: WindowSession, nowMs: number): { session: string, ts: string }[] {
  if (window.root === undefined)
    return []
  const beats = db.prepare(LIVE_WINDOW_BEATS).all(window.root, window.session) as { session: string, ts: string }[]
  return beats.filter(beat => beatsLive(beat.ts, nowMs))
}

export function anotherWindowLine(root: string, others: { session: string, ts: string }[]): string {
  return `another window lives in ${root}: ${others.map(other => `session ${other.session} beat at ${other.ts}`).join(', ')}; name it to the owner before writing here`
}

export function windowSessionOf(env: NodeJS.ProcessEnv): string | null {
  const window = windowOf(env)
  return window?.mode === 'loop' ? window.session : null
}

export type WindowBeatFields = SessionGauges & { mode?: WindowMode, root?: string }

export function recordWindowHeartbeat(db: DatabaseSync, ts: string, session: string, fields: WindowBeatFields = {}): boolean {
  return appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: `${WINDOW_ACTOR}${session}`, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:${session}:${ts}`, payload: { session, ...fields }, legacy: false })
}

export function windowBeat(bus: string, window: WindowSession | null, now: () => number, measure: SessionMeasure = measureSession, say: (line: string) => void = line => console.error(line)): () => void {
  let last = Number.NEGATIVE_INFINITY
  const named = new Set<string>()
  return () => {
    const at = now()
    if (window === null || at - last < WINDOW_BEAT_MS)
      return
    try {
      const db = openBus(bus)
      try {
        const others = otherLiveWindows(db, window, at).filter(other => !named.has(other.session))
        if (window.root !== undefined && others.length > 0) {
          say(anotherWindowLine(window.root, others))
          others.forEach(other => named.add(other.session))
        }
        recordWindowHeartbeat(db, new Date(at).toISOString(), window.session, { mode: window.mode, ...(window.root === undefined ? {} : { root: window.root }), ...measure(window.session) })
      }
      finally {
        db.close()
      }
      last = at
    }
    catch (error) {
      if (!busLocked(error))
        throw error
    }
  }
}

function busLocked(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' && (code & PRIMARY_RESULT_CODE) === SQLITE_BUSY
}

export function lastLoopBeats(db: DatabaseSync): { name: string, ts: string }[] {
  return db.prepare(LAST_LOOP_BEATS).all() as { name: string, ts: string }[]
}

export function windowLive(db: DatabaseSync, nowMs: number, windowEnded: string | null): boolean {
  const lastBeat = (db.prepare(LAST_WINDOW_BEAT).get(windowEnded ?? '') as { ts: string | null }).ts
  return (lastBeat !== null && beatsLive(lastBeat, nowMs)) || lastLoopBeats(db).some(beat => beatsLive(beat.ts, nowMs))
}
