import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Fold, StoredEvent } from './stored.js'
import { appendEvent, inTransaction } from './db.js'
import { CARD_STOPPED } from './inbox.js'
import { FAILURES_TO_STOP, LEASE_MS, StaleLease } from './lease.js'
import { payloadOf, reject, storedByKey } from './stored.js'

export const ROLE_STOPPED = 'role.stopped'
export const ROLE_LEASED = 'role.leased'
export const ROLE_RAISED = 'role.raised'
export const ROLE_RAISE_FAILED = 'role.raise_failed'
export const ROLE_TO_OWNER = 'role.to_owner'
export const ROLES = ['operator', 'miko'] as const
export const THRESHOLDS = ['context', 'spend'] as const
export const RAISED_STATUS = 'CONTINUE'
export const RAISED_VARIABLE = 'CONSTRUCT_BUS_RAISED'
export const RAISES_PER_HANDOFF = 3

export type Role = typeof ROLES[number]

export interface RoleStop {
  role: Role
  handoff: string
  status: string
  reason: string
  raised: boolean
}

export interface RoleLease {
  role: Role
  handoff: string
  leaseGen: number
  actor: string
}

export interface RoleToOwner {
  role: Role
  handoff: string
  detail: string
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
  raises: number
  failures: number
  event_id: number
}

const AT_A_THRESHOLD = `status = '${RAISED_STATUS}' AND reason IN (${THRESHOLDS.map(reason => `'${reason}'`).join(', ')})`
const WITHIN_CEILING = `raises < ${RAISES_PER_HANDOFF} AND failures < ${FAILURES_TO_STOP}`
const ROLE_COLUMNS = 'role, handoff, state, lease_gen, lease_until, raises, failures, event_id'

const RAISABLE = `
  SELECT ${ROLE_COLUMNS} FROM roles
  WHERE ${AT_A_THRESHOLD} AND ${WITHIN_CEILING}
    AND (state = '${STOPPED}' OR (state = '${LEASED}' AND lease_until < ?))
  ORDER BY role LIMIT 1
`

const PAST_THE_CEILING = `
  SELECT ${ROLE_COLUMNS} FROM roles
  WHERE ${AT_A_THRESHOLD} AND state = '${STOPPED}' AND NOT (${WITHIN_CEILING})
  ORDER BY role LIMIT 1
`

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

export const ROLE_FOLDS: Record<string, Fold> = {
  [ROLE_STOPPED]: foldStopped,
  [ROLE_LEASED]: foldLeased,
  [ROLE_RAISED]: foldRaised,
  [ROLE_RAISE_FAILED]: foldRaiseFailed,
  [ROLE_TO_OWNER]: foldToOwner,
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

function ceilingDetail(row: RoleRow): string {
  return row.raises >= RAISES_PER_HANDOFF
    ? `${row.raises} raises on ${row.handoff} and it stopped at a threshold again; the bus raises it no more until a session the owner started stops`
    : `${row.failures} raises in a row failed on ${row.handoff}; the bus raises it no more until a session the owner started stops`
}

export function roleToOwner(db: DatabaseSync, ts: string, actor: string): RoleToOwner | null {
  return inTransaction(db, () => {
    const row = db.prepare(PAST_THE_CEILING).get() as RoleRow | undefined
    if (row === undefined)
      return null
    const detail = ceilingDetail(row)
    folded(db, { ts, type: ROLE_TO_OWNER, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_TO_OWNER}:${row.role}:${row.event_id}`, payload: { role: row.role, handoff: row.handoff, detail }, legacy: false })
    appendEvent(db, { ts, type: CARD_STOPPED, actor, cardId: null, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${ROLE_TO_OWNER}:${row.role}:${row.event_id}`, payload: { reason: 'question.owner', role: row.role, handoff: row.handoff, detail }, legacy: false })
    return { role: row.role, handoff: row.handoff, detail }
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

export function failRaise(db: DatabaseSync, ts: string, lease: RoleLease, detail: string): void {
  inTransaction(db, () => {
    assertRoleHeld(db, lease)
    folded(db, { ts, type: ROLE_RAISE_FAILED, actor: lease.actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_RAISE_FAILED}:${lease.role}:${lease.leaseGen}`, payload: { role: lease.role, handoff: lease.handoff, lease_gen: lease.leaseGen, detail }, legacy: false })
  })
}
