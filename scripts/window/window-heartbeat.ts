import type { DatabaseSync } from 'node:sqlite'
import type { ClientAdapter } from '../ports/client/contract.js'
import type { WindowMode } from '../ports/session.js'
import type { SessionMeasure } from '../supervisor/heartbeat.js'
import type { SessionGauges } from './eddies-measure.js'
import type { WindowCrawler } from './window-agents.js'
import os from 'node:os'
import process from 'node:process'
import { appendEvent, openBus } from '../core/db.js'
import { EITHER_JOURNAL, events, processBeats } from '../core/events-query.js'
import { PROCESS_ENDED, WINDOW_HEARTBEAT } from '../core/events.js'
import { WINDOW_ACTOR } from '../core/node.js'
import { windowModeOf } from '../ports/session.js'
import { measureSession } from '../supervisor/heartbeat.js'
import { beatsLive } from '../supervisor/liveness-sites.js'
import { LOADED_CORE_VARIABLE } from './eddies-measure.js'
import { windowPresenceOf } from './window-agents.js'

export const WINDOW_BEAT_MS = 5 * 60_000
export const LOOP_PROCESS = 'miko:'

const PROJECT_VARIABLE = 'CLAUDE_PROJECT_DIR'
const SESSION_ID = /^[^:\s]+$/
const SQLITE_BUSY = 5
const PRIMARY_RESULT_CODE = 0xFF

function jsonText(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

function newestFirst(a: { ts: string }, b: { ts: string }): number {
  return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0
}

function liveWindowBeats(db: DatabaseSync, root: string, ownSession: string): { session: string, ts: string }[] {
  const latest = new Map<string, string>()
  for (const beat of events(db, { types: [WINDOW_HEARTBEAT], valid: true, mentions: jsonText(root) })) {
    const session = beat.data?.session
    if (beat.data?.root !== root || session === undefined || session === null || session === ownSession)
      continue
    const held = latest.get(String(session))
    if (held === undefined || beat.ts > held)
      latest.set(String(session), beat.ts)
  }
  return [...latest].map(([session, ts]) => ({ session, ts })).sort(newestFirst)
}

function endedSince(db: DatabaseSync, name: string, ts: string): boolean {
  return events(db, { types: [PROCESS_ENDED], valid: true, legacy: EITHER_JOURNAL, from: ts, mentions: jsonText(name) }).some(ended => ended.data?.process === name)
}

export interface WindowSession {
  session: string
  mode: WindowMode
  root?: string
}

export type SessionOwner = Pick<ClientAdapter, 'ownSession'>

export function windowOf(client: SessionOwner, env: NodeJS.ProcessEnv): WindowSession | null {
  const session = client.ownSession(env)?.trim()
  const mode = windowModeOf(env)
  const root = env[PROJECT_VARIABLE]?.trim()
  if (mode === null || session === undefined || !SESSION_ID.test(session))
    return null
  return root === undefined || root === '' ? { session, mode } : { session, mode, root }
}

export function otherLiveWindows(db: DatabaseSync, window: WindowSession, nowMs: number): { session: string, ts: string }[] {
  if (window.root === undefined)
    return []
  return liveWindowBeats(db, window.root, window.session).filter(beat => beatsLive(beat.ts, nowMs))
}

export function anotherWindowLine(root: string, others: { session: string, ts: string }[]): string {
  return `another window lives in ${root}: ${others.map(other => `session ${other.session} beat at ${other.ts}`).join(', ')}; name it to the owner before writing here`
}

export function windowSessionOf(client: SessionOwner, env: NodeJS.ProcessEnv): string | null {
  const window = windowOf(client, env)
  return window?.mode === 'loop' ? window.session : null
}

export interface WindowLook {
  core?: number
  crawlers: WindowCrawler[]
  skills: string[]
}

export type WindowBeatFields = SessionGauges & Partial<WindowLook> & { mode?: WindowMode, root?: string }

export type WindowLooker = (window: WindowSession) => WindowLook

export function loadedCoreOf(env: NodeJS.ProcessEnv): number | null {
  const core = Number(env[LOADED_CORE_VARIABLE])
  return Number.isSafeInteger(core) && core > 0 ? core : null
}

export function lookAtWindow(window: WindowSession, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): WindowLook {
  const core = loadedCoreOf(env)
  return { ...(core === null ? {} : { core }), ...windowPresenceOf(home, window.root ?? process.cwd(), window.session) }
}

export function recordWindowHeartbeat(db: DatabaseSync, ts: string, session: string, fields: WindowBeatFields = {}): boolean {
  return appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: `${WINDOW_ACTOR}${session}`, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:${session}:${ts}`, payload: { session, ...fields }, legacy: false })
}

export function windowBeat(bus: string, window: WindowSession | null, now: () => number, measure: SessionMeasure = measureSession, say: (line: string) => void = line => console.error(line), look: WindowLooker = lookAtWindow): () => void {
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
        recordWindowHeartbeat(db, new Date(at).toISOString(), window.session, { mode: window.mode, ...(window.root === undefined ? {} : { root: window.root }), ...measure(window.session), ...look(window) })
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
  return processBeats(db, LOOP_PROCESS).filter(beat => !endedSince(db, beat.process, beat.ts)).map(beat => ({ name: beat.process, ts: beat.ts })).sort(newestFirst)
}

export function windowLive(db: DatabaseSync, nowMs: number, windowEnded: string | null): boolean {
  const after = windowEnded ?? ''
  const lastBeat = events(db, { types: [WINDOW_HEARTBEAT], from: after, newestFirst: true, limit: 2 }).find(beat => beat.ts > after)?.ts ?? null
  return (lastBeat !== null && beatsLive(lastBeat, nowMs)) || lastLoopBeats(db).some(beat => beatsLive(beat.ts, nowMs))
}
