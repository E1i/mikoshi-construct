import type { DatabaseSync } from 'node:sqlite'
import { CARD_VARIABLE } from '../ghosts/session.js'
import { appendEvent, openBus } from './db.js'
import { WINDOW_ACTOR } from './window-requests.js'

export const WINDOW_HEARTBEAT = 'window.heartbeat'
export const WINDOW_BEAT_MS = 5 * 60_000

const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SESSION_ID = /^[^:\s]+$/

export function windowSessionOf(env: NodeJS.ProcessEnv): string | null {
  const session = env[SESSION_VARIABLE]?.trim()
  return !env[CARD_VARIABLE] && session !== undefined && SESSION_ID.test(session) ? session : null
}

export function recordWindowHeartbeat(db: DatabaseSync, ts: string, session: string): boolean {
  return appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: `${WINDOW_ACTOR}${session}`, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:${session}:${ts}`, payload: { session }, legacy: false })
}

export function windowBeat(bus: string, session: string | null, now: () => number): () => void {
  let last = Number.NEGATIVE_INFINITY
  return () => {
    const at = now()
    if (session === null || at - last < WINDOW_BEAT_MS)
      return
    last = at
    const db = openBus(bus)
    try {
      recordWindowHeartbeat(db, new Date(at).toISOString(), session)
    }
    finally {
      db.close()
    }
  }
}
