import type { ProcessTable } from '../ports/process-table.js'
import type { ProcessList, RunningProcess } from './bg.js'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { alive, argsBeforeBus, processBeatsOn, servesBus } from './bg.js'

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
