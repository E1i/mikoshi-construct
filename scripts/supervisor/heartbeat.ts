import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { EventRow } from '../core/events-query.js'
import type { HolderStart, Lease } from '../core/lease.js'
import type { SessionGauges } from '../window/eddies-measure.js'
import type { HostVitals } from './host-vitals.js'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendEvent, defaultBusPath, inTransaction, openBus, recordBeat } from '../core/db.js'
import { BY_CARD, events, lastPer, processBeats } from '../core/events-query.js'
import { BOARD_ALARM, PROCESS_HEARTBEAT, SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../core/events.js'
import { prOf } from '../core/identifiers.js'
import { LEASE_FOLDS } from '../core/lease.js'
import { storedByKey } from '../core/stored.js'
import { HOST_DEGRADED, hostAlarmKey, hostDegradedLine } from '../ports/host-fault.js'
import { isFullSha } from '../ports/identifier-shapes.js'
import { CARD_VARIABLE, clientAdapter } from '../ports/session.js'
import { projectRoot, sessionGauges } from '../window/eddies-measure.js'
import { crossedVitals, hostDegradedCause, sampleVitals } from './host-vitals.js'

export type { LastHeartbeat } from '../core/card-readings.js'
export { lastHeartbeat } from '../core/card-readings.js'
export { pidOfProcess, retirePreviousGeneration } from '../core/db.js'

export const PR_VARIABLE = 'CONSTRUCT_PR'
export const HEAD_VARIABLE = 'CONSTRUCT_HEAD'
export const STEP_VARIABLE = 'CONSTRUCT_STEP'
export const LEASE_VARIABLE = 'CONSTRUCT_LEASE'
export const LEASE_GEN_VARIABLE = 'CONSTRUCT_LEASE_GEN'

export const CARD_PROCESS = 'card:'
export const WINDOW_PROCESS = 'window:'

const POSITIVE_NUMBER = /^[1-9]\d*$/
const SESSION_ID = /^[^:\s]+$/

const WINDOW_SESSION_KEY = '$.session'

export interface ProcessBeat {
  process: string
  ts: string
}

export interface QueueCapacity {
  queue: string
  slots: number
}

export function ownStart(): HolderStart {
  return { pid: process.pid, started: new Date(Date.now() - process.uptime() * 1000).toISOString() }
}

export const SUPERVISOR_BEAT = 'supervisor'

export type VitalsReading = () => HostVitals

export const HOST_VITALS: VitalsReading = () => sampleVitals()

const VITALS_ALARM = 'vitals'

function raiseHostDegraded(db: DatabaseSync, ts: string, vitals: HostVitals): void {
  const cause = hostDegradedCause(vitals)
  if (cause !== null)
    appendEvent(db, { ts, type: BOARD_ALARM, actor: `worker:${SUPERVISOR_BEAT}:${process.pid}`, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${hostAlarmKey(HOST_DEGRADED, VITALS_ALARM, ts)}`, payload: { reason: HOST_DEGRADED, cause: crossedVitals(vitals).join(','), detail: hostDegradedLine(cause) }, legacy: false })
}

export function recordProcessHeartbeat(db: DatabaseSync, ts: string, name: string, capacity?: QueueCapacity, vitalsOf: VitalsReading | null = null): boolean {
  const vitals = vitalsOf?.()
  const recorded = recordBeat(db, { process: name, type: PROCESS_HEARTBEAT, ts, payload: { process: name, ...capacity, ...(vitals === undefined ? {} : { vitals }) } })
  if (vitals !== undefined)
    raiseHostDegraded(db, ts, vitals)
  return recorded
}

function latestOfEachProcess(beats: readonly ProcessBeat[]): ProcessBeat[] {
  const latest = new Map<string, string>()
  for (const beat of beats) {
    const held = latest.get(beat.process)
    if (held === undefined || beat.ts > held)
      latest.set(beat.process, beat.ts)
  }
  return [...latest.keys()].sort().map(name => ({ process: name, ts: latest.get(name)! }))
}

function windowBeats(db: DatabaseSync): ProcessBeat[] {
  return lastPer(db, WINDOW_SESSION_KEY, { types: [WINDOW_HEARTBEAT] }).flatMap((row) => {
    const session = row.data?.session
    return session === undefined || session === null ? [] : [{ process: `${WINDOW_PROCESS}${String(session)}`, ts: row.ts }]
  })
}

export function lastProcessBeats(db: DatabaseSync): ProcessBeat[] {
  const cards = lastPer(db, BY_CARD, { types: [SESSION_HEARTBEAT], withCard: true }).map(row => ({ process: `${CARD_PROCESS}${row.card_id}`, ts: row.ts }))
  return latestOfEachProcess([...processBeats(db), ...cards, ...windowBeats(db)])
}

export function retiredRowsLines(prefix: string, retired: readonly string[]): string[] {
  return retired.length === 0 ? [] : [`${prefix}retired the heartbeat rows of a previous generation whose processes are gone: ${retired.join(', ')}; the board no longer counts them, and a fresh beat under the same name counts again`]
}

export interface HeldLease {
  taskKey: string
  leaseGen: number
}

export interface Heartbeat {
  card: number
  pr: number | null
  head: string | null
  step: string
  session: string
  lease: HeldLease | null
}

export type BeatReading = SessionGauges & { start_context?: number | null, read_before_edit?: number | null }

export type SessionMeasure = (session: string) => BeatReading

function budgetReading(root: string, session: string): BeatReading {
  try {
    const budget = clientAdapter().readBudget({ session, cwd: root, stdoutPath: null })
    return { start_context: budget.startContext, read_before_edit: budget.readBeforeEdit }
  }
  catch {
    return {}
  }
}

function beatReading(home: string, root: string, session: string): BeatReading {
  const gauges = sessionGauges(home, root, session)
  return gauges.reason === undefined ? { ...gauges, ...budgetReading(root, session) } : gauges
}

export function measureSession(session: string): BeatReading {
  return sessionGauges(os.homedir(), projectRoot(process.env), session)
}

export function measureCardSession(session: string): BeatReading {
  return beatReading(os.homedir(), projectRoot(process.env), session)
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

export function leaseHeartbeat(lease: Lease, session: string): Heartbeat {
  return { card: lease.cardId, pr: lease.pr, head: lease.head, step: lease.queue, session, lease: lease.leaseGen > 0 ? { taskKey: lease.taskKey, leaseGen: lease.leaseGen } : null }
}

export function recordHeartbeat(db: DatabaseSync, ts: string, beat: Heartbeat, measure: SessionMeasure = measureCardSession): void {
  const gauges = measure(beat.session)
  const dedupeKey = `${SESSION_HEARTBEAT}:${beat.card}:${beat.session}:${ts}`
  const event: BusEvent = { ts, type: SESSION_HEARTBEAT, actor: `worker:session:${beat.session}`, cardId: beat.card, pr: beat.pr, head: beat.head, dedupeKey, payload: JSON.stringify({ step: beat.step, session: beat.session, ...(beat.lease === null ? {} : { task_key: beat.lease.taskKey, lease_gen: beat.lease.leaseGen }), start_context: null, read_before_edit: null, ...gauges }), legacy: false }
  inTransaction(db, () => {
    if (appendEvent(db, event))
      LEASE_FOLDS[SESSION_HEARTBEAT]!(db, storedByKey(db, dedupeKey))
  })
}

export interface LeaseBeat {
  ts: string
  session: string | null
  context: number | null
}

export function heartbeatsOfLease(db: DatabaseSync, lease: HeldLease): EventRow[] {
  return events(db, { types: [SESSION_HEARTBEAT], task: lease.taskKey }).filter(row => row.data?.lease_gen === lease.leaseGen)
}

export function beatsOfLease(db: DatabaseSync, lease: HeldLease): LeaseBeat[] {
  return heartbeatsOfLease(db, lease).map(row => ({ ts: row.ts, session: (row.data?.session ?? null) as string | null, context: (row.data?.context ?? null) as number | null }))
}

export function busSessionPulse(busPath: string, clock: () => Date, measure: SessionMeasure = measureCardSession): (lease: Lease, session: string) => string {
  return (lease, session) => {
    const ts = clock().toISOString()
    const db = openBus(busPath)
    try {
      recordHeartbeat(db, ts, leaseHeartbeat(lease, session), measure)
    }
    finally {
      db.close()
    }
    return ts
  }
}

export function runHeartbeat(env: NodeJS.ProcessEnv, session: string | undefined, bus: string, now: () => Date, home = os.homedir(), root = process.cwd()): number {
  const beat = heartbeatOf(env, session)
  if (beat === null)
    return 0
  const db = openBus(bus)
  try {
    recordHeartbeat(db, now().toISOString(), beat, session => beatReading(home, root, session))
  }
  finally {
    db.close()
  }
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runHeartbeat(process.env, process.argv[2], defaultBusPath(), () => new Date())
