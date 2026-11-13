import type { DatabaseSync } from 'node:sqlite'
import type { ProcessTable } from '../ports/process-table.js'
import type { ProcessIdentity } from '../core/node.js'
import type { ProcessList, RunningProcess } from './bg.js'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { defaultBusPath, openBus } from '../core/db.js'
import { childrenNotEnded, GENERATION_VARIABLE, recordedWorkers, UNHANDED } from '../core/node.js'
import { identityOf, OsProcessTable, rowsOf, runningAs } from '../ports/process-table.js'
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

export function sessionLifeIn(table: ProcessTable): LifeOf {
  return (session) => {
    const snapshot = table.snapshot()
    if (!snapshot.readable)
      return 'unknown'
    return snapshot.rows.some(row => row.command.split(/\s+/).includes(session)) ? 'live' : 'dead'
  }
}

export interface IdentifiedProcess extends RunningProcess {
  group: number
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

export function ownIdentity(table: ProcessTable = new OsProcessTable()): ProcessIdentity | null {
  return identityOf(table.snapshot(), process.pid)
}

export function identifiedOnBus(table: ProcessTable = new OsProcessTable()): () => IdentifiedProcess[] {
  return () => {
    const db = openBus(defaultBusPath())
    try {
      return identifiedProcesses(table, db)()
    }
    finally {
      db.close()
    }
  }
}

export function generationEnv(code: { head: () => string }, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  try {
    return { ...env, [GENERATION_VARIABLE]: code.head() }
  }
  catch {
    return { ...env, [GENERATION_VARIABLE]: UNHANDED }
  }
}
