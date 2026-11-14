import type { DatabaseSync } from 'node:sqlite'
import type { ChildStart, IdentityReader, ProcessIdentity, WorkerIdentity } from '../core/node.js'
import type { ProcessRow, ProcessSnapshot, ProcessTable } from '../ports/process-table.js'
import type { ProcessList, RunningProcess } from './bg.js'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { openBus } from '../core/db.js'
import { CHILD_ENDED, CHILD_STARTED, WORKER_STARTED } from '../core/events.js'
import { EXECUTOR_MODES, GENERATION_VARIABLE, matchingEvents, UNHANDED } from '../core/node.js'
import { payloadOf } from '../core/stored.js'
import { identityOf, lstartOf, OsProcessTable, rowOf, rowsOf } from '../ports/process-table.js'
import { alive, argsBeforeBus, processBeatsOn, servesBus, withBuses } from './bg.js'

export type PidAlive = (pid: number) => boolean

export type SessionLife = 'live' | 'dead' | 'unknown'

export type LifeOf = (session: string) => SessionLife

export interface RecordedWorkerSite {
  file: string
  node: string
  markers: readonly string[]
  bus: string | undefined
}

export function recordedPidLives(pid: number, isAlive: PidAlive = alive): boolean {
  return Number.isInteger(pid) && pid > 0 && isAlive(pid)
}

export function recordedPid(file: string): number | null {
  if (!existsSync(file))
    return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function recordedWorker(site: RecordedWorkerSite, processes: ProcessList, isAlive: PidAlive = alive, nowMs: number = Date.now()): RunningProcess | undefined {
  const pid = recordedPid(site.file)
  if (pid === null || pid === process.pid || !recordedPidLives(pid, isAlive) || !processBeatsOn(site.bus, site.node, nowMs))
    return undefined
  const listed = processes().find(candidate => candidate.pid === pid)
  if (listed === undefined)
    return undefined
  return servesBus(listed, site.bus) && site.markers.some(marker => argsBeforeBus(listed.args).includes(marker)) ? listed : undefined
}

export function ownIdentity(table: ProcessTable = new OsProcessTable(), pid: number = process.pid): ProcessIdentity | null {
  return identityOf(table.snapshot(), pid)
}

export function tableIdentity(table: ProcessTable = new OsProcessTable()): IdentityReader {
  return pid => identityOf(table.snapshot(), pid)
}

export function generationEnv(code: { head: () => string }, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  try {
    return { ...env, [GENERATION_VARIABLE]: code.head() }
  }
  catch {
    return { ...env, [GENERATION_VARIABLE]: UNHANDED }
  }
}

export interface IdentifiedProcess extends RunningProcess {
  group: number
}

const EVERY_EVENT = Number.MAX_SAFE_INTEGER

export const SAME_START_MS = 2_000

export function sameStart(recorded: string, running: string): boolean {
  return Math.abs(Date.parse(recorded) - Date.parse(running)) < SAME_START_MS
}

export function runningAs(snapshot: ProcessSnapshot, recorded: { pid: number, lstart: string }): ProcessRow | null {
  const row = rowOf(snapshot, recorded.pid)
  const lstart = row === null ? null : lstartOf(row)
  return row !== null && lstart !== null && sameStart(recorded.lstart, lstart) ? row : null
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function datable(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function textOr(value: unknown, otherwise: string): string {
  return typeof value === 'string' ? value : otherwise
}

function recordedOf(db: DatabaseSync, type: string): { id: number, payload: Record<string, unknown> }[] {
  return matchingEvents(db, [type], 0, EVERY_EVENT).flatMap((event) => {
    try {
      return [{ id: event.id, payload: payloadOf(event) }]
    }
    catch {
      return []
    }
  })
}

export function recordedWorkers(db: DatabaseSync): WorkerIdentity[] {
  const latest = new Map<string, WorkerIdentity>()
  for (const { payload } of recordedOf(db, WORKER_STARTED)) {
    if (typeof payload.worker !== 'string' || !positive(payload.pid) || !datable(payload.started))
      continue
    const lstart = datable(payload.lstart) ? payload.lstart : payload.started
    latest.set(payload.worker, { worker: payload.worker, pid: payload.pid, started: payload.started, instance: textOr(payload.instance, UNHANDED), generation: textOr(payload.generation, UNHANDED), pgid: positive(payload.pgid) ? payload.pgid : null, lstart })
  }
  return [...latest.values()]
}

const childKey = (instance: unknown, pid: unknown, taskKey: unknown): string => JSON.stringify([instance, pid, taskKey])

export function childrenNotEnded(db: DatabaseSync): ChildStart[] {
  const endedAt = new Map(recordedOf(db, CHILD_ENDED).map(ended => [childKey(ended.payload.instance, ended.payload.pid, ended.payload.task_key), ended.id]))
  return recordedOf(db, CHILD_STARTED).flatMap(({ id, payload }) => {
    const mode = EXECUTOR_MODES.find(each => each === payload.mode)
    const ended = endedAt.get(childKey(payload.instance, payload.pid, payload.task_key))
    if ((ended !== undefined && ended > id) || mode === undefined || !positive(payload.pid) || !positive(payload.pgid) || !datable(payload.lstart) || typeof payload.instance !== 'string' || typeof payload.task_key !== 'string')
      return []
    return [{ mode, instance: payload.instance, generation: textOr(payload.generation, UNHANDED), pid: payload.pid, pgid: payload.pgid, lstart: payload.lstart, kind: textOr(payload.kind, ''), taskKey: payload.task_key, tree: typeof payload.tree === 'string' ? payload.tree : null }]
  })
}

export function identifiedProcesses(table: ProcessTable, db: DatabaseSync): () => IdentifiedProcess[] {
  return () => {
    const snapshot = table.snapshot()
    rowsOf(snapshot)
    const children = new Set(childrenNotEnded(db).flatMap(child => runningAs(snapshot, child) === null ? [] : [child.pid]))
    const workers = recordedWorkers(db).flatMap((worker) => {
      const row = runningAs(snapshot, worker)
      return row === null || children.has(row.pid) ? [] : [row]
    })
    const unique = [...new Map(workers.map(row => [row.pid, row])).values()]
    return withBuses(unique.map(row => ({ pid: row.pid, group: row.pgid, args: row.command })))
  }
}

export function identifiedOnBus(busPath: () => string, table: ProcessTable = new OsProcessTable()): () => IdentifiedProcess[] {
  return () => {
    const db = openBus(busPath())
    try {
      return identifiedProcesses(table, db)()
    }
    finally {
      db.close()
    }
  }
}

export function readableRows(table: ProcessTable = new OsProcessTable()): () => RunningProcess[] {
  return () => {
    const snapshot = table.snapshot()
    return snapshot.readable ? withBuses(snapshot.rows.map(row => ({ pid: row.pid, args: row.command }))) : []
  }
}

export function sessionLifeIn(table: ProcessTable): LifeOf {
  return (session) => {
    const snapshot = table.snapshot()
    if (!snapshot.readable)
      return 'unknown'
    return snapshot.rows.some(row => row.command.split(/\s+/).includes(session)) ? 'live' : 'dead'
  }
}
