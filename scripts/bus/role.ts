import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { ROLE_LEASED, ROLE_RAISED, ROLE_RETURNED, ROLE_STOPPED, WINDOW_HEARTBEAT } from '../core/events.js'
import { appendEvent, inTransaction, openBusWait } from './db.js'
import { LEASE_MS } from './lease.js'
import { payloadOf, reject } from './stored.js'
import { reduceProjection } from './watermark.js'
import { WINDOW_ACTOR } from './window-requests.js'

export const ROLE_RAISE_FAILED = 'role.raise_failed'
export const ROLE_TO_OWNER = 'role.to_owner'
export const ROLES = ['operator', 'miko'] as const
export const THRESHOLDS = ['context', 'spend'] as const
export const RAISED_STATUS = 'CONTINUE'
export const RAISED_VARIABLE = 'CONSTRUCT_BUS_RAISED'
export const WINDOW_ENDS = ['eddies', 'miko:exit', 'close'] as const

export type Role = typeof ROLES[number]
export type WindowEnd = typeof WINDOW_ENDS[number]

export interface RoleStop {
  role: Role
  handoff: string
  status: string
  reason: string
  raised: boolean
}

export interface RoleToOwner {
  role: Role
  handoff: string
  detail: string
  wait: string | null
}

export interface RoleReturned {
  role: Role
  handoff: string
  lastSign: string
}

const STOPPED = 'stopped'
const LEASED = 'leased'
const RAISED = 'raised'
const OWNER = 'owner'

interface RoleRow {
  role: Role
  handoff: string
  state: string
  lease_gen: number
  lease_until: string | null
  reason: string
  event_id: number
}

const AT_A_THRESHOLD = `status = '${RAISED_STATUS}' AND reason IN (${THRESHOLDS.map(reason => `'${reason}'`).join(', ')})`
const ROLE_COLUMNS = 'role, handoff, state, lease_gen, lease_until, reason, event_id'

const STOPPED_AT_A_THRESHOLD = `
  SELECT ${ROLE_COLUMNS} FROM roles
  WHERE ${AT_A_THRESHOLD} AND state = '${STOPPED}'
  ORDER BY role LIMIT 1
`

const SILENT_OWNER_SESSION = `
  SELECT roles.role, roles.handoff, roles.event_id, max(signs.ts) AS last_sign FROM roles
  JOIN events AS signs ON signs.id > roles.event_id AND (signs.type = '${WINDOW_HEARTBEAT}' OR signs.actor LIKE '${WINDOW_ACTOR}%')
  WHERE roles.state = '${OWNER}'
  GROUP BY roles.role HAVING max(signs.ts) < ?
  ORDER BY roles.role LIMIT 1
`

export interface RoleReading {
  role: Role
  state: string
  lease_until: string | null
  pid: number | null
  ts: string
}

export function roleReadings(db: DatabaseSync): RoleReading[] {
  return db.prepare('SELECT roles.role, roles.state, roles.lease_until, roles.pid, events.ts FROM roles JOIN events ON events.id = roles.event_id ORDER BY roles.role').all() as unknown as RoleReading[]
}

export function raisedByTheBus(env: NodeJS.ProcessEnv): boolean {
  return env[RAISED_VARIABLE] === '1'
}

function text(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return typeof value === 'string' && value !== '' ? value : reject(`${field} is not a non-empty string`)
}

function roleOf(payload: Record<string, unknown>): Role {
  return ROLES.find(each => each === payload.role) ?? reject(`role is not one of ${ROLES.join(' | ')}`)
}

function generationOf(payload: Record<string, unknown>): number {
  const value = payload.lease_gen
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : reject('lease_gen is not a positive integer')
}

function rowOf(db: DatabaseSync, role: Role): RoleRow | undefined {
  return db.prepare(`SELECT ${ROLE_COLUMNS} FROM roles WHERE role = ?`).get(role) as RoleRow | undefined
}

function leaseUntil(ts: string): string {
  return new Date(Date.parse(ts) + LEASE_MS).toISOString()
}

function heldRow(db: DatabaseSync, payload: Record<string, unknown>): RoleRow {
  const role = roleOf(payload)
  const row = rowOf(db, role) ?? reject(`role ${role} never stopped`)
  if (row.state !== LEASED || row.lease_gen !== generationOf(payload))
    reject(`role ${role} is not leased under lease_gen ${String(payload.lease_gen)}`)
  return row
}

function foldStopped(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const raised = payload.raised
  if (typeof raised !== 'boolean')
    reject('raised is not a boolean')
  db.prepare(`
    INSERT INTO roles (role, handoff, status, reason, state, event_id) VALUES (?, ?, ?, ?, '${STOPPED}', ?)
    ON CONFLICT (role) DO UPDATE SET handoff = excluded.handoff, status = excluded.status, reason = excluded.reason,
      state = excluded.state, lease_until = NULL, pid = NULL, failures = 0,
      raises = CASE WHEN ? AND roles.handoff = excluded.handoff THEN roles.raises ELSE 0 END, event_id = excluded.event_id
  `).run(roleOf(payload), text(payload, 'handoff'), text(payload, 'status'), text(payload, 'reason'), event.id, raised ? 1 : 0)
}

function foldLeased(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const role = roleOf(payload)
  const row = rowOf(db, role) ?? reject(`role ${role} never stopped`)
  const lapsed = row.state === LEASED && row.lease_until !== null && row.lease_until < event.ts
  if (row.state !== STOPPED && !lapsed)
    reject(`role ${role} is ${row.state}, not stopped`)
  if (generationOf(payload) !== row.lease_gen + 1)
    reject(`lease_gen ${String(payload.lease_gen)} does not follow ${row.lease_gen}`)
  db.prepare('UPDATE roles SET state = ?, lease_gen = ?, lease_until = ?, event_id = ? WHERE role = ?').run(LEASED, row.lease_gen + 1, leaseUntil(event.ts), event.id, role)
}

function foldRaised(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  const row = heldRow(db, payload)
  const pid = payload.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    reject('pid is not a positive integer')
  db.prepare('UPDATE roles SET state = ?, lease_until = NULL, pid = ?, raises = raises + 1, failures = 0, event_id = ? WHERE role = ?').run(RAISED, pid, event.id, row.role)
}

function foldRaiseFailed(db: DatabaseSync, event: StoredEvent): void {
  const row = heldRow(db, payloadOf(event))
  db.prepare('UPDATE roles SET state = ?, lease_until = NULL, failures = failures + 1, event_id = ? WHERE role = ?').run(STOPPED, event.id, row.role)
}

function foldToOwner(db: DatabaseSync, event: StoredEvent): void {
  const role = roleOf(payloadOf(event))
  const row = rowOf(db, role) ?? reject(`role ${role} never stopped`)
  if (row.state !== STOPPED)
    reject(`role ${role} is ${row.state}, not stopped`)
  db.prepare('UPDATE roles SET state = ?, event_id = ? WHERE role = ?').run(OWNER, event.id, role)
}

function foldReturned(db: DatabaseSync, event: StoredEvent): void {
  const role = roleOf(payloadOf(event))
  const row = rowOf(db, role) ?? reject(`role ${role} never stopped`)
  if (row.state !== OWNER)
    reject(`role ${role} is ${row.state}, not with the owner`)
  db.prepare('UPDATE roles SET state = ?, lease_until = NULL, pid = NULL, raises = 0, failures = 0, event_id = ? WHERE role = ?').run(STOPPED, event.id, role)
}

export const ROLE_FOLDS: Record<string, Fold> = {
  [ROLE_STOPPED]: foldStopped,
  [ROLE_LEASED]: foldLeased,
  [ROLE_RAISED]: foldRaised,
  [ROLE_RAISE_FAILED]: foldRaiseFailed,
  [ROLE_TO_OWNER]: foldToOwner,
  [ROLE_RETURNED]: foldReturned,
}

export const ROLES_PROJECTION: IncrementalProjection = { table: 'roles', folds: ROLE_FOLDS }

function reduced(db: DatabaseSync, event: BusEvent): boolean {
  const appended = appendEvent(db, event)
  reduceProjection(db, ROLES_PROJECTION)
  return appended
}

export function observeRoleStop(db: DatabaseSync, ts: string, actor: string, stop: RoleStop): boolean {
  return inTransaction(db, () => reduced(db, { ts, type: ROLE_STOPPED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_STOPPED}:${stop.role}:${ts}`, payload: { ...stop }, legacy: false }))
}

const ROLE_STARTS: Record<Role, string | null> = { miko: 'pnpm miko', operator: null }

function ownerDetail(row: RoleRow, start: string | null): string {
  const stopped = `${row.role} stopped at its ${row.reason} threshold on ${row.handoff}; the bus raises no role`
  return start === null ? `${stopped}, and ${row.role} has no launcher since the shift runner was removed` : `${stopped}: start it in a terminal with ${start}`
}

export function roleToOwner(db: DatabaseSync, ts: string, actor: string): RoleToOwner | null {
  return inTransaction(db, () => {
    const row = db.prepare(STOPPED_AT_A_THRESHOLD).get() as RoleRow | undefined
    if (row === undefined)
      return null
    const start = ROLE_STARTS[row.role]
    const detail = ownerDetail(row, start)
    const wait = start === null ? null : openBusWait(db, ts, actor, { need: 'command', text: detail, command: start })
    reduced(db, { ts, type: ROLE_TO_OWNER, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_TO_OWNER}:${row.role}:${row.event_id}`, payload: { role: row.role, handoff: row.handoff, detail, wait }, legacy: false })
    return { role: row.role, handoff: row.handoff, detail, wait }
  })
}

export function returnSilentRole(db: DatabaseSync, ts: string, actor: string): RoleReturned | null {
  return inTransaction(db, () => {
    const silentSince = new Date(Date.parse(ts) - LEASE_MS).toISOString()
    const row = db.prepare(SILENT_OWNER_SESSION).get(silentSince) as { role: Role, handoff: string, event_id: number, last_sign: string } | undefined
    if (row === undefined)
      return null
    reduced(db, { ts, type: ROLE_RETURNED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_RETURNED}:${row.role}:${row.event_id}`, payload: { role: row.role, handoff: row.handoff, last_sign: row.last_sign }, legacy: false })
    return { role: row.role, handoff: row.handoff, lastSign: row.last_sign }
  })
}

export function returnEndedRole(db: DatabaseSync, ts: string, actor: string, role: Role, end: WindowEnd): RoleReturned | null {
  return inTransaction(db, () => {
    const row = rowOf(db, role)
    if (row?.state !== OWNER)
      return null
    reduced(db, { ts, type: ROLE_RETURNED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_RETURNED}:${row.role}:${row.event_id}`, payload: { role: row.role, handoff: row.handoff, last_sign: ts, ended: end }, legacy: false })
    return { role: row.role, handoff: row.handoff, lastSign: ts }
  })
}
