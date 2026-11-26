import type { DatabaseSync } from 'node:sqlite'
import type { HostFaultSource } from '../ports/host-fault.js'
import type { HostThermal, ThermalLevel } from '../ports/host-thermal.js'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { events } from '../core/events-query.js'
import { BOARD_ALARM } from '../core/events.js'
import { HOST_DEGRADED } from '../ports/host-fault.js'
import { HOST_THERMAL } from '../ports/host-thermal.js'
import { userProcessCount } from '../ports/process-table.js'

export interface LastHostFailures {
  github: string | null
  dns: string | null
  getpwuid: string | null
}

export interface HostVitals {
  userProcesses: number | null
  maxProcPerUid: number | null
  loadPerCore: number
  descriptors: number | null
  failures: LastHostFailures
  thermal: ThermalLevel
}

export interface VitalsProbe {
  userProcesses: () => number | null
  maxProcPerUid: () => number | null
  load: () => { busy: number, cores: number }
  descriptors: () => number | null
  thermal: HostThermal
}

export const VITAL_LINES = { processShare: 0.8, loadPerCore: 1.5, descriptors: 4096 } as const

export type Vital = 'user-processes' | 'load-per-core' | 'descriptors' | 'thermal'

const PASSWD_LOOKUP = /getpwuid|uv_os_get_passwd|userInfo/i
const COMMAND_TIMEOUT_MS = 2_000
const OWN_DESCRIPTORS = '/dev/fd'

function commandNumber(command: string, args: string[]): number | null {
  const run = spawnSync(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
  const value = Number.parseInt(run.stdout ?? '', 10)
  return run.status === 0 && Number.isFinite(value) ? value : null
}

function processesOfUser(): number | null {
  const uid = process.getuid?.()
  if (uid === undefined)
    return null
  return userProcessCount(uid)
}

function ownDescriptors(): number | null {
  try {
    return readdirSync(OWN_DESCRIPTORS).length
  }
  catch {
    return null
  }
}

export const MACHINE_PROBE: VitalsProbe = {
  userProcesses: processesOfUser,
  maxProcPerUid: () => commandNumber('sysctl', ['-n', 'kern.maxprocperuid']),
  load: () => ({ busy: os.loadavg()[0] ?? 0, cores: os.availableParallelism() }),
  descriptors: ownDescriptors,
  thermal: HOST_THERMAL,
}

function latestDetail(db: DatabaseSync, source: HostFaultSource, matches: (detail: string) => boolean = () => true): string | null {
  const alarm = events(db, { types: [BOARD_ALARM], newestFirst: true }).find(row => row.data?.reason === HOST_DEGRADED && row.data.cause === source && matches(String(row.data.detail ?? '')))
  return alarm === undefined ? null : `${alarm.ts} ${String(alarm.data?.detail ?? '')}`
}

export function lastHostFailures(db: DatabaseSync): LastHostFailures {
  return {
    github: latestDetail(db, 'github'),
    dns: latestDetail(db, 'network'),
    getpwuid: latestDetail(db, 'os', detail => PASSWD_LOOKUP.test(detail)),
  }
}

export function sampleVitals(db: DatabaseSync, probe: VitalsProbe = MACHINE_PROBE): HostVitals {
  const load = probe.load()
  return {
    userProcesses: probe.userProcesses(),
    maxProcPerUid: probe.maxProcPerUid(),
    loadPerCore: load.cores > 0 ? load.busy / load.cores : 0,
    descriptors: probe.descriptors(),
    failures: lastHostFailures(db),
    thermal: probe.thermal.level(),
  }
}

export function crossedVitals(vitals: HostVitals): Vital[] {
  const crossed: Vital[] = []
  if (vitals.userProcesses !== null && vitals.maxProcPerUid !== null && vitals.userProcesses >= vitals.maxProcPerUid * VITAL_LINES.processShare)
    crossed.push('user-processes')
  if (vitals.loadPerCore >= VITAL_LINES.loadPerCore)
    crossed.push('load-per-core')
  if (vitals.descriptors !== null && vitals.descriptors >= VITAL_LINES.descriptors)
    crossed.push('descriptors')
  if (vitals.thermal === 'heavy')
    crossed.push('thermal')
  return crossed
}

function vitalLine(vital: Vital, vitals: HostVitals): string {
  switch (vital) {
    case 'user-processes':
      return `user processes ${vitals.userProcesses} of kern.maxprocperuid ${vitals.maxProcPerUid} (line ${VITAL_LINES.processShare * 100}%)`
    case 'load-per-core':
      return `load per core ${vitals.loadPerCore.toFixed(2)} (line ${VITAL_LINES.loadPerCore})`
    case 'descriptors':
      return `open descriptors of the bus process ${vitals.descriptors} (line ${VITAL_LINES.descriptors})`
    case 'thermal':
      return `thermal pressure ${vitals.thermal}`
  }
}

export function hostDegradedCause(vitals: HostVitals): string | null {
  const crossed = crossedVitals(vitals)
  return crossed.length === 0 ? null : `the host crossed its line on ${crossed.map(vital => vitalLine(vital, vitals)).join('; ')}`
}
