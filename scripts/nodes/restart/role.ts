import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import type { EventStamp, Signs } from '../../core/events-query.js'
import type { EventPayload } from '../../core/events.js'
import type { Fold, StoredEvent } from '../../core/stored.js'
import type { IncrementalProjection } from '../../core/watermark.js'
import { closedWaitIds } from '../../core/card-readings.js'
import { appendEvent, inTransaction, openBusWait, OWNER_ANSWER_LIFT } from '../../core/db.js'
import { EITHER_JOURNAL, events, signStampsSince } from '../../core/events-query.js'
import { OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, ROLE_LEASED, ROLE_RAISE_FAILED, ROLE_RAISED, ROLE_RETURNED, ROLE_STOPPED, ROLE_TO_OWNER, WINDOW_HEARTBEAT } from '../../core/events.js'
import { LEASE_MS } from '../../core/lease.js'
import { WINDOW_ACTOR } from '../../core/node.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { payloadOf, reject } from '../../core/stored.js'
import { reduceProjection } from '../../core/watermark.js'
import { windowLive } from '../../window/window-heartbeat.js'

export const ROLES = ['operator', 'miko'] as const
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

const ROLE_COLUMNS = 'role, handoff, state, lease_gen, lease_until, reason, event_id'

function stoppedAtAThreshold(thresholds: readonly string[]): string {
  return `
  SELECT ${ROLE_COLUMNS} FROM roles
  WHERE status = '${RAISED_STATUS}' AND reason IN (${thresholds.map(() => '?').join(', ')}) AND state = '${STOPPED}'
  ORDER BY role
`
}

const OWNER_SESSIONS = `SELECT ${ROLE_COLUMNS} FROM roles WHERE state = '${OWNER}' ORDER BY role`
const WINDOW_SIGNS: Signs = { types: [WINDOW_HEARTBEAT], actorPrefix: WINDOW_ACTOR }
const WINDOW_BEATS: Signs = { types: [WINDOW_HEARTBEAT, ROLE_RETURNED], actorPrefix: WINDOW_ACTOR }

function latestOf(stamps: readonly string[]): string | null {
  return stamps.reduce<string | null>((latest, ts) => latest === null || ts > latest ? ts : latest, null)
}

function earliestOf(stamps: readonly string[]): string | null {
  return stamps.reduce<string | null>((earliest, ts) => earliest === null || ts < earliest ? ts : earliest, null)
}

export function lastWindowEnd(db: DatabaseSync): string | null {
  return latestOf(events(db, { types: [ROLE_RETURNED], valid: true, legacy: EITHER_JOURNAL })
    .flatMap(returned => returned.data?.ended === undefined || returned.data.ended === null ? [] : [returned.ts]))
}

export interface SilentOwnerSession {
  role: Role
  handoff: string
  event_id: number
  last_sign: string
}

export function silentOwnerSession(owned: readonly Pick<RoleRow, 'role' | 'handoff' | 'event_id'>[], signs: readonly EventStamp[], silentSince: string): SilentOwnerSession | null {
  for (const row of owned) {
    const lastSign = latestOf(signs.filter(sign => sign.id > row.event_id).map(sign => sign.ts))
    if (lastSign !== null && lastSign < silentSince)
      return { role: row.role, handoff: row.handoff, event_id: row.event_id, last_sign: lastSign }
  }
  return null
}

function silentOwnerSessionIn(db: DatabaseSync, silentSince: string): SilentOwnerSession | null {
  const owned = db.prepare(OWNER_SESSIONS).all() as unknown as RoleRow[]
  if (owned.length === 0)
    return null
  const signs = signStampsSince(db, Math.min(...owned.map(row => row.event_id)), WINDOW_SIGNS)
  return silentOwnerSession(owned, signs, silentSince)
}

export interface RoleReading {
  role: Role
  state: string
  lease_until: string | null
  pid: number | null
  ts: string
}

export function roleReadings(db: DatabaseSync): RoleReading[] {
  const rows = db.prepare('SELECT role, state, lease_until, pid, event_id FROM roles ORDER BY role').all() as unknown as (Omit<RoleReading, 'ts'> & { event_id: number })[]
  const stamps = new Map(events(db, { ids: rows.map(row => Number(row.event_id)), legacy: EITHER_JOURNAL }).map(event => [event.id, event.ts]))
  return rows.flatMap(({ event_id, ...row }) => {
    const ts = stamps.get(Number(event_id))
    return ts === undefined ? [] : [{ ...row, ts }]
  })
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

const ROLE_STARTS: Record<Role, string | null> = { miko: pnpmCommand('miko'), operator: null }

function ownerDetail(row: RoleRow, start: string | null): string {
  const stopped = `${row.role} stopped at its ${row.reason} threshold on ${row.handoff}; the bus raises no role`
  return start === null ? `${stopped}, and ${row.role} has no launcher since the shift runner was removed` : `${stopped}: start it in a terminal with ${start}`
}

const START_COMMANDS = Object.values(ROLE_STARTS).filter((start): start is string => start !== null)

interface AnsweredStartWait {
  id: string
  beat: string
}

function byWaitId(a: AnsweredStartWait, b: AnsweredStartWait): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function startWaitsAWindowBeatAnswered(db: DatabaseSync): AnsweredStartWait[] {
  const opened = events(db, { types: [OWNER_WAIT_OPENED], valid: true })
    .filter(open => open.data?.need === 'command' && START_COMMANDS.includes(open.data.command as string) && typeof open.data.id === 'string')
  if (opened.length === 0)
    return []
  const closed = new Set<unknown>([...closedWaitIds(db), ...events(db, { types: [OWNER_WAIT_CLOSED], legacy: EITHER_JOURNAL }).map(close => close.data?.id)])
  const beats = signStampsSince(db, Math.min(...opened.map(open => open.id)), WINDOW_BEATS)
  return opened.flatMap((open) => {
    const id = open.data!.id as string
    const beat = earliestOf(beats.filter(each => each.id > open.id).map(each => each.ts))
    return closed.has(id) || beat === null ? [] : [{ id, beat }]
  }).sort(byWaitId)
}

function closeStartWaitsAWindowBeatAnswered(db: DatabaseSync, ts: string, actor: string): void {
  for (const { id, beat } of startWaitsAWindowBeatAnswered(db))
    appendEvent(db, { ts, type: OWNER_WAIT_CLOSED, actor, cardId: null, pr: null, head: null, dedupeKey: `${OWNER_WAIT_CLOSED}:${id}`, payload: { id, answer: `the window beat again at ${beat}` }, legacy: false })
}

export function roleToOwner(db: DatabaseSync, ts: string, actor: string, thresholds: readonly string[]): RoleToOwner | null {
  return inTransaction(db, () => {
    closeStartWaitsAWindowBeatAnswered(db, ts, actor)
    const stopped = db.prepare(stoppedAtAThreshold(thresholds)).all(...thresholds) as unknown as RoleRow[]
    const startable = stopped.some(each => ROLE_STARTS[each.role] !== null)
    const live = startable && windowLive(db, Date.parse(ts), lastWindowEnd(db))
    const row = stopped.find(each => !live || ROLE_STARTS[each.role] === null)
    if (row === undefined)
      return null
    const start = ROLE_STARTS[row.role]
    const detail = ownerDetail(row, start)
    const wait = start === null ? null : openBusWait(db, closedWaitIds(db), ts, actor, { need: 'command', text: detail, command: start, lift: OWNER_ANSWER_LIFT })
    reduced(db, { ts, type: ROLE_TO_OWNER, actor, cardId: null, pr: null, head: null, dedupeKey: `${ROLE_TO_OWNER}:${row.role}:${row.event_id}`, payload: { role: row.role, handoff: row.handoff, detail, wait } satisfies EventPayload<typeof ROLE_TO_OWNER>, legacy: false })
    return { role: row.role, handoff: row.handoff, detail, wait }
  })
}

export function returnSilentRole(db: DatabaseSync, ts: string, actor: string): RoleReturned | null {
  return inTransaction(db, () => {
    const silentSince = new Date(Date.parse(ts) - LEASE_MS).toISOString()
    const row = silentOwnerSessionIn(db, silentSince)
    if (row === null)
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
