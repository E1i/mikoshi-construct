import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from './lease.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { PROCESS_HEARTBEAT, SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../core/events.js'
import { CARD_VARIABLE } from '../ports/session.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from './db.js'
import { isFullSha, prOf } from './identifiers.js'
import { LEASE_FOLDS } from './lease.js'
import { storedByKey } from './stored.js'

export const PR_VARIABLE = 'CONSTRUCT_PR'
export const HEAD_VARIABLE = 'CONSTRUCT_HEAD'
export const STEP_VARIABLE = 'CONSTRUCT_STEP'
export const LEASE_VARIABLE = 'CONSTRUCT_LEASE'
export const LEASE_GEN_VARIABLE = 'CONSTRUCT_LEASE_GEN'

export const EDDIES_STATE_FILE = '.construct/eddies.jsonl'

const GAUGE_FIELDS: Readonly<Record<string, keyof SessionGauges>> = { 'session-context': 'context', 'session-spend': 'spent' }

export const CARD_PROCESS = 'card:'
export const WINDOW_PROCESS = 'window:'

const POSITIVE_NUMBER = /^[1-9]\d*$/
const SESSION_ID = /^[^:\s]+$/

const LAST_HEARTBEAT = `
  SELECT ts, pr, head, payload FROM events WHERE type = '${SESSION_HEARTBEAT}' AND card_id = ?
  ORDER BY id DESC LIMIT 1
`

const LAST_PROCESS_BEATS = `
  SELECT name, max(ts) AS ts FROM (
    SELECT json_extract(payload, '$.process') AS name, ts FROM events WHERE type = '${PROCESS_HEARTBEAT}' AND legacy = 0 AND json_valid(payload)
    UNION ALL
    SELECT '${CARD_PROCESS}' || card_id AS name, ts FROM events WHERE type = '${SESSION_HEARTBEAT}' AND legacy = 0 AND card_id IS NOT NULL
    UNION ALL
    SELECT '${WINDOW_PROCESS}' || json_extract(payload, '$.session') AS name, ts FROM events WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0 AND json_valid(payload)
  )
  WHERE name IS NOT NULL
  GROUP BY name
  ORDER BY name
`

export interface ProcessBeat {
  process: string
  ts: string
}

export function recordProcessHeartbeat(db: DatabaseSync, ts: string, name: string): boolean {
  return appendEvent(db, { ts, type: PROCESS_HEARTBEAT, actor: `worker:process:${name.replaceAll(':', '-')}`, cardId: null, pr: null, head: null, dedupeKey: `${PROCESS_HEARTBEAT}:${name}:${ts}`, payload: { process: name }, legacy: false })
}

export function lastProcessBeats(db: DatabaseSync): ProcessBeat[] {
  return (db.prepare(LAST_PROCESS_BEATS).all() as { name: string, ts: string }[]).map(row => ({ process: row.name, ts: row.ts }))
}

export interface HeldLease {
  taskKey: string
  leaseGen: number
}

export interface SessionGauges {
  context?: number
  spent?: number
}

export interface Heartbeat {
  card: number
  pr: number | null
  head: string | null
  step: string
  session: string
  lease: HeldLease | null
  gauges?: SessionGauges
}

export interface LastHeartbeat {
  ts: string
  pr: number | null
  head: string | null
  step: string | null
  session: string | null
}

export function heartbeatEnv(lease: Pick<Lease, 'cardId' | 'pr' | 'head' | 'queue'> & Partial<Pick<Lease, 'taskKey' | 'leaseGen'>>): Record<string, string> {
  return {
    [CARD_VARIABLE]: String(lease.cardId),
    ...(lease.pr === null ? {} : { [PR_VARIABLE]: String(lease.pr) }),
    ...(lease.head === null ? {} : { [HEAD_VARIABLE]: lease.head }),
    [STEP_VARIABLE]: lease.queue,
    ...(lease.taskKey === undefined || lease.leaseGen === undefined ? {} : { [LEASE_VARIABLE]: lease.taskKey, [LEASE_GEN_VARIABLE]: String(lease.leaseGen) }),
  }
}

function heldLeaseOf(env: NodeJS.ProcessEnv): HeldLease | null {
  const taskKey = env[LEASE_VARIABLE]
  const leaseGen = env[LEASE_GEN_VARIABLE]
  return taskKey !== undefined && taskKey !== '' && leaseGen !== undefined && POSITIVE_NUMBER.test(leaseGen) ? { taskKey, leaseGen: Number(leaseGen) } : null
}

export function heartbeatOf(env: NodeJS.ProcessEnv, session: string | undefined): Heartbeat | null {
  const card = env[CARD_VARIABLE]
  if (card === undefined || !POSITIVE_NUMBER.test(card) || session === undefined || !SESSION_ID.test(session))
    return null
  const head = env[HEAD_VARIABLE]
  const pr = env[PR_VARIABLE]
  return {
    card: Number(card),
    pr: pr !== undefined && POSITIVE_NUMBER.test(pr) ? prOf(Number(pr)) : null,
    head: isFullSha(head) ? head : null,
    step: env[STEP_VARIABLE] || 'session',
    session,
    lease: heldLeaseOf(env),
  }
}

function parsedLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

export function sessionGaugesOf(journal: string, session: string): SessionGauges {
  const gauges: SessionGauges = {}
  for (const line of journal.split('\n')) {
    const entry = parsedLine(line)
    const field = typeof entry?.level === 'string' ? GAUGE_FIELDS[entry.level] : undefined
    if (field !== undefined && entry!.session_id === session && typeof entry!.spent === 'number' && Number.isFinite(entry!.spent))
      gauges[field] = entry!.spent
  }
  return gauges
}

export function eddiesStateOf(root: string, session: string): SessionGauges {
  const file = path.join(root, EDDIES_STATE_FILE)
  try {
    return existsSync(file) ? sessionGaugesOf(readFileSync(file, 'utf8'), session) : {}
  }
  catch {
    return {}
  }
}

export function recordHeartbeat(db: DatabaseSync, ts: string, beat: Heartbeat): void {
  const dedupeKey = `${SESSION_HEARTBEAT}:${beat.card}:${beat.session}:${ts}`
  inTransaction(db, () => {
    if (appendEvent(db, { ts, type: SESSION_HEARTBEAT, actor: `worker:session:${beat.session}`, cardId: beat.card, pr: beat.pr, head: beat.head, dedupeKey, payload: { step: beat.step, session: beat.session, ...(beat.lease === null ? {} : { task_key: beat.lease.taskKey, lease_gen: beat.lease.leaseGen }), ...beat.gauges }, legacy: false }))
      LEASE_FOLDS[SESSION_HEARTBEAT]!(db, storedByKey(db, dedupeKey))
  })
}

function textField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' ? value : null
}

export function lastHeartbeat(db: DatabaseSync, card: number): LastHeartbeat | null {
  const row = db.prepare(LAST_HEARTBEAT).get(card) as { ts: string, pr: number | null, head: string | null, payload: string } | undefined
  if (row === undefined)
    return null
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  return { ts: row.ts, pr: row.pr, head: row.head, step: textField(payload, 'step'), session: textField(payload, 'session') }
}

export function runHeartbeat(env: NodeJS.ProcessEnv, session: string | undefined, bus: string, now: () => Date, root = process.cwd()): number {
  const beat = heartbeatOf(env, session)
  if (beat === null)
    return 0
  const db = openBus(bus)
  try {
    recordHeartbeat(db, now().toISOString(), { ...beat, gauges: eddiesStateOf(root, beat.session) })
  }
  finally {
    db.close()
  }
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runHeartbeat(process.env, process.argv[2], defaultBusPath(), () => new Date())
