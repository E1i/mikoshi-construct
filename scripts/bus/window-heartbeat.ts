import type { DatabaseSync } from 'node:sqlite'
import type { SessionGauges } from '../miko/eddies-measure.js'
import os from 'node:os'
import process from 'node:process'
import { WINDOW_HEARTBEAT } from '../core/events.js'
import { projectRoot, sessionGauges } from '../miko/eddies-measure.js'
import { CARD_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../ports/session.js'
import { appendEvent, openBus } from './db.js'
import { WINDOW_ACTOR } from './window-requests.js'

export const WINDOW_BEAT_MS = 5 * 60_000

const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SESSION_ID = /^[^:\s]+$/

export function windowSessionOf(env: NodeJS.ProcessEnv): string | null {
  const session = env[SESSION_VARIABLE]?.trim()
  const marked = env[WINDOW_VARIABLE] === WINDOW_MARK && !env[CARD_VARIABLE]
  return marked && session !== undefined && SESSION_ID.test(session) ? session : null
}

export function recordWindowHeartbeat(db: DatabaseSync, ts: string, session: string, gauges: SessionGauges = {}): boolean {
  return appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: `${WINDOW_ACTOR}${session}`, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:${session}:${ts}`, payload: { session, ...gauges }, legacy: false })
}

function windowSessionGauges(session: string): SessionGauges {
  return sessionGauges(os.homedir(), projectRoot(process.env), session)
}

export function windowBeat(bus: string, session: string | null, now: () => number, measure: (session: string) => SessionGauges = windowSessionGauges): () => void {
  let last = Number.NEGATIVE_INFINITY
  return () => {
    const at = now()
    if (session === null || at - last < WINDOW_BEAT_MS)
      return
    last = at
    const db = openBus(bus)
    try {
      recordWindowHeartbeat(db, new Date(at).toISOString(), session, measure(session))
    }
    finally {
      db.close()
    }
  }
}
