import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Fold, StoredEvent } from './stored.js'
import { appendEvent, inTransaction } from './db.js'
import { LEASE_MS, StaleLease } from './lease.js'
import { payloadOf, reject, storedByKey } from './stored.js'

export const ROLE_STOPPED = 'role.stopped'
export const ROLE_LEASED = 'role.leased'
export const ROLE_RAISED = 'role.raised'
export const ROLES = ['operator', 'miko'] as const
export const THRESHOLDS = ['context', 'spend'] as const
export const RAISED_STATUS = 'CONTINUE'

export type Role = typeof ROLES[number]

export interface RoleStop {
  role: Role
  handoff: string
  status: string
  reason: string
}

export interface RoleLease {
  role: Role
  handoff: string
  leaseGen: number
  actor: string
}

const STOPPED = 'stopped'
const LEASED = 'leased'
const RAISED = 'raised'

interface RoleRow {
  role: Role
  handoff: string
  state: string
  lease_gen: number
  lease_until: string | null
}

const RAISABLE = `
  SELECT role, handoff, state, lease_gen, lease_until FROM roles
  WHERE status = '${RAISED_STATUS}' AND reason IN (${THRESHOLDS.map(reason => `'${reason}'`).join(', ')})
    AND (state = '${STOPPED}' OR (state = '${LEASED}' AND lease_until < ?))
  ORDER BY role LIMIT 1
`

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
  return db.prepare('SELECT role, handoff, state, lease_gen, lease_until FROM roles WHERE role = ?').get(role) as RoleRow | undefined
}

function leaseUntil(ts: string): string {
  return new Date(Date.parse(ts) + LEASE_MS).toISOString()
}

function foldStopped(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOf(event)
  db.prepare(`
    INSERT INTO roles (role, handoff, status, reason, state, event_id) VALUES (?, ?, ?, ?, '${STOPPED}', ?)
    ON CONFLICT (role) DO UPDATE SET handoff = excluded.handoff, status = excluded.status, reason = excluded.reason,
      state = excluded.state, lease_until = NULL, pid = NULL, event_id = excluded.event_id
  `).run(roleOf(payload), text(payload, 'handoff'), text(payload, 'status'), text(payload, 'reason'), event.id)
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
  const role = roleOf(payload)
  const row = rowOf(db, role) ?? reject(`role ${role} never stopped`)
  if (row.state !== LEASED || row.lease_gen !== generationOf(payload))
    reject(`role ${role} is not leased under lease_gen ${String(payload.lease_gen)}`)
  const pid = payload.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    reject('pid is not a positive integer')
  db.prepare('UPDATE roles SET state = ?, lease_until = NULL, pid = ?, event_id = ? WHERE role = ?').run(RAISED, pid, event.id, role)
}

export const ROLE_FOLDS: Record<string, Fold> = {
  [ROLE_STOPPED]: foldStopped,
  [ROLE_LEASED]: foldLeased,
  [ROLE_RAISED]: foldRaised,
}

function folded(db: DatabaseSync, event: BusEvent): void {
  if (appendEvent(db, event))
    ROLE_FOLDS[event.type]!(db, storedByKey(db, event.dedupeKey))
}

export function observeRoleStop(db: DatabaseSync, ts: string, actor: string, stop: RoleStop): boolean {
  return appendEvent(db, { ts, type: ROLE_STOPPED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_STOPPED}:${stop.role}:${ts}`, payload: { ...stop }, legacy: false })
}

export function leaseRole(db: DatabaseSync, ts: string, actor: string): RoleLease | null {
  return inTransaction(db, () => {
    const row = db.prepare(RAISABLE).get(ts) as RoleRow | undefined
    if (row === undefined)
      return null
    const leaseGen = row.lease_gen + 1
    folded(db, { ts, type: ROLE_LEASED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_LEASED}:${row.role}:${leaseGen}`, payload: { role: row.role, lease_gen: leaseGen }, legacy: false })
    return { role: row.role, handoff: row.handoff, leaseGen, actor }
  })
}

export function assertRoleHeld(db: DatabaseSync, lease: RoleLease): void {
  const row = rowOf(db, lease.role)
  if (row === undefined || row.state !== LEASED || row.lease_gen !== lease.leaseGen)
    throw new StaleLease(`role ${lease.role} is no longer leased under lease_gen ${lease.leaseGen}`)
}

export function raiseRole(db: DatabaseSync, ts: string, lease: RoleLease, pid: number): void {
  inTransaction(db, () => {
    assertRoleHeld(db, lease)
    folded(db, { ts, type: ROLE_RAISED, actor: lease.actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_RAISED}:${lease.role}:${lease.leaseGen}`, payload: { role: lease.role, handoff: lease.handoff, lease_gen: lease.leaseGen, pid }, legacy: false })
  })
}
