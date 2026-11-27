import type { DatabaseSync } from 'node:sqlite'
import type { ThermalLevel } from '../../ports/host-thermal.js'
import type { VitalsProbe } from '../../supervisor/host-vitals.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE } from '../../core/bus-path.js'
import { HEARTBEATS } from '../../core/db.js'
import { BOARD_ALARM, PROCESS_HEARTBEAT } from '../../core/events.js'
import { idleLoad, MachineSessions } from '../../core/machine-sessions.js'
import { HostGate } from '../../nodes/launch/host-gate.js'
import { ghPort } from '../../ports/gh.js'
import { syncThroughPort } from '../../ports/git.js'
import { ghApi } from '../../ports/github.js'
import { HOST_DEGRADED, HOST_FAILURES } from '../../ports/host-fault.js'
import { fixedThermal } from '../../ports/host-thermal.js'
import { recordProcessHeartbeat, SUPERVISOR_BEAT } from '../../supervisor/heartbeat.js'
import { sampleVitals } from '../../supervisor/host-vitals.js'
import { LivenessJudge, SUPERVISOR_PROCESS } from '../../supervisor/liveness-judge.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'host-vitals-'))
  roots.push(root)
  vi.stubEnv(BUS_DB_VARIABLE, path.join(root, 'bus.db'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function probe(busy: number, thermal: ThermalLevel = 'nominal'): VitalsProbe {
  return { userProcesses: () => 571, maxProcPerUid: () => 8000, load: () => ({ busy, cores: 16 }), descriptors: () => 48, failures: () => HOST_FAILURES.last(), thermal: fixedThermal(thermal) }
}

function beatOf(db: DatabaseSync, process: string): Record<string, unknown> {
  const row = db.prepare(`SELECT payload FROM ${HEARTBEATS} WHERE process = ? AND type = ?`).get(process, PROCESS_HEARTBEAT) as { payload: string }
  return JSON.parse(row.payload) as Record<string, unknown>
}

const NO_SLEEP = { attempts: 2, firstMs: 1, sleep: () => {} }

function githubAnswered(status: number): void {
  const port = ghPort({ spawn: () => ({ status: 1, stdout: '', stderr: `gh: Server Error (HTTP ${status})` }), pause: () => {} })
  ghApi('.', port)('repos/o/r/pulls')
}

function fetchUnresolved(host: string): void {
  const fetch = (): string => {
    throw Object.assign(new Error('Command failed: git fetch origin main'), { stderr: `fatal: unable to access 'https://${host}/o/r/': Could not resolve host: ${host}\n` })
  }
  expect(() => syncThroughPort(fetch, '/tree', ['fetch', 'origin', 'main'], NO_SLEEP)).toThrow()
}

function passwdLookupFailed(): Error {
  return Object.assign(new Error('A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)'), { code: 'ERR_SYSTEM_ERROR', info: { errno: -2, code: 'ENOENT', syscall: 'uv_os_get_passwd' } })
}

function launchGate(made: MergeBench): HostGate {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-vitals-machine-'))
  roots.push(dir)
  return new HostGate(made.db, new MachineSessions(dir, () => false, 16, made.clock.now, idleLoad(16)), 'worker:launch:node-1', () => made.clock.now().toISOString())
}

const beat = (made: MergeBench, busy: number, thermal: ThermalLevel = 'nominal'): boolean => recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, () => sampleVitals(probe(busy, thermal)))

describe('the host vitals of the supervisor heartbeat', () => {
  it('every supervisor heartbeat records the host vitals', () => {
    const made = bench()
    githubAnswered(599)
    fetchUnresolved('github.com')
    expect(launchGate(made).degraded(2340, passwdLookupFailed())).toBe(HOST_DEGRADED)

    beat(made, 8)
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), 'node:launch')

    expect(beatOf(made.db, SUPERVISOR_BEAT)).toEqual({
      process: SUPERVISOR_BEAT,
      vitals: {
        userProcesses: 571,
        maxProcPerUid: 8000,
        loadPerCore: 0.5,
        descriptors: 48,
        failures: {
          github: expect.stringContaining('HTTP 599') as unknown,
          dns: expect.stringContaining('Could not resolve host: github.com') as unknown,
          getpwuid: expect.stringContaining('uv_os_get_passwd') as unknown,
        },
        thermal: 'nominal',
      },
    })
    expect(beatOf(made.db, 'node:launch')).toEqual({ process: 'node:launch' })
  })

  it('a vitals alarm and a launch host fault in one hour are both recorded, and the heartbeat names the last failure of the hour', () => {
    const made = bench()
    beat(made, 32)
    const gate = launchGate(made)
    fetchUnresolved('first.example')
    expect(gate.degraded(2341, new Error('fatal: unable to access: Could not resolve host: first.example'))).toBe(HOST_DEGRADED)
    made.clock.advance(60_000)
    fetchUnresolved('second.example')
    expect(gate.degraded(2342, new Error('fatal: unable to access: Could not resolve host: second.example'))).toBe(HOST_DEGRADED)
    beat(made, 8)

    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([
      { reason: HOST_DEGRADED, cause: 'load-per-core', detail: expect.stringContaining('load per core 2.00') as unknown },
      { reason: HOST_DEGRADED, cause: 'network', detail: expect.stringContaining('card #2341') as unknown },
    ])
    expect(beatOf(made.db, SUPERVISOR_BEAT)).toMatchObject({ vitals: { failures: { dns: expect.stringContaining('second.example') as unknown } } })
  })

  it('the host degraded alarm names the vital that crossed its line', () => {
    const made = bench()
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, () => sampleVitals(probe(8)))
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([])

    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, () => sampleVitals(probe(32)))
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, () => sampleVitals(probe(40)))

    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([{ reason: HOST_DEGRADED, cause: 'load-per-core', detail: expect.stringContaining('load per core 2.00 (line 1.5)') as unknown }])
  })

  it('every supervisor heartbeat records the thermal pressure level', () => {
    const made = bench()
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, () => sampleVitals(probe(8, 'moderate')))
    expect(beatOf(made.db, SUPERVISOR_BEAT)).toMatchObject({ vitals: { thermal: 'moderate' } })

    made.clock.advance(60_000)
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, () => sampleVitals(probe(8, 'heavy')))
    expect(beatOf(made.db, SUPERVISOR_BEAT)).toMatchObject({ vitals: { thermal: 'heavy' } })
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([{ reason: HOST_DEGRADED, cause: 'thermal', detail: expect.stringContaining('thermal pressure heavy') as unknown }])
  })

  it('the liveness judge beats with the vitals its root hands it, and a judge handed none samples no host', async () => {
    const sampled = bench()
    await new LivenessJudge(sampled.db, () => sampled.clock.now().getTime(), () => () => false, async () => [], undefined, () => sampleVitals(probe(8, 'heavy'))).step()
    expect(beatOf(sampled.db, SUPERVISOR_PROCESS)).toMatchObject({ vitals: { thermal: 'heavy' } })

    const unsampled = bench()
    await new LivenessJudge(unsampled.db, () => unsampled.clock.now().getTime(), () => () => false).step()
    expect(beatOf(unsampled.db, SUPERVISOR_PROCESS)).toEqual({ process: SUPERVISOR_PROCESS })
    expect(eventsOf(unsampled.db, BOARD_ALARM)).toEqual([])
  })
})
