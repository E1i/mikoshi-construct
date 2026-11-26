import type { DatabaseSync } from 'node:sqlite'
import type { ThermalLevel } from '../../ports/host-thermal.js'
import type { VitalsProbe } from '../../supervisor/host-vitals.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, HEARTBEATS } from '../../core/db.js'
import { BOARD_ALARM, PROCESS_HEARTBEAT } from '../../core/events.js'
import { HOST_DEGRADED } from '../../ports/host-fault.js'
import { fixedThermal } from '../../ports/host-thermal.js'
import { recordProcessHeartbeat, SUPERVISOR_BEAT } from '../../supervisor/heartbeat.js'
import { sampleVitals } from '../../supervisor/host-vitals.js'
import { LivenessJudge, SUPERVISOR_PROCESS } from '../../supervisor/supervisor.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function probe(busy: number, thermal: ThermalLevel = 'nominal'): VitalsProbe {
  return { userProcesses: () => 571, maxProcPerUid: () => 8000, load: () => ({ busy, cores: 16 }), descriptors: () => 48, thermal: fixedThermal(thermal) }
}

function beatOf(db: DatabaseSync, process: string): Record<string, unknown> {
  const row = db.prepare(`SELECT payload FROM ${HEARTBEATS} WHERE process = ? AND type = ?`).get(process, PROCESS_HEARTBEAT) as { payload: string }
  return JSON.parse(row.payload) as Record<string, unknown>
}

function hostFailure(made: MergeBench, cause: string, detail: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: BOARD_ALARM, actor: 'worker:launch:node-1', cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${cause}:${detail}`, payload: { reason: HOST_DEGRADED, cause, detail }, legacy: false })
}

describe('the host vitals of the supervisor heartbeat', () => {
  it('every supervisor heartbeat records the host vitals', () => {
    const made = bench()
    hostFailure(made, 'github', 'GitHub answered 599: netwatch')
    hostFailure(made, 'network', 'fatal: unable to access: Could not resolve host: github.com')
    hostFailure(made, 'os', 'ENOENT: A system error occurred: uv_os_get_passwd returned ENOENT')

    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, db => sampleVitals(db, probe(8)))
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), 'node:launch')

    expect(beatOf(made.db, SUPERVISOR_BEAT)).toEqual({
      process: SUPERVISOR_BEAT,
      vitals: {
        userProcesses: 571,
        maxProcPerUid: 8000,
        loadPerCore: 0.5,
        descriptors: 48,
        failures: {
          github: expect.stringContaining('GitHub answered 599') as unknown,
          dns: expect.stringContaining('Could not resolve host') as unknown,
          getpwuid: expect.stringContaining('uv_os_get_passwd') as unknown,
        },
        thermal: 'nominal',
      },
    })
    expect(beatOf(made.db, 'node:launch')).toEqual({ process: 'node:launch' })
  })

  it('the host degraded alarm names the vital that crossed its line', () => {
    const made = bench()
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, db => sampleVitals(db, probe(8)))
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([])

    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, db => sampleVitals(db, probe(32)))
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, db => sampleVitals(db, probe(40)))

    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([{ reason: HOST_DEGRADED, cause: 'load-per-core', detail: expect.stringContaining('load per core 2.00 (line 1.5)') as unknown }])
  })

  it('every supervisor heartbeat records the thermal pressure level', () => {
    const made = bench()
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, db => sampleVitals(db, probe(8, 'moderate')))
    expect(beatOf(made.db, SUPERVISOR_BEAT)).toMatchObject({ vitals: { thermal: 'moderate' } })

    made.clock.advance(60_000)
    recordProcessHeartbeat(made.db, made.clock.now().toISOString(), SUPERVISOR_BEAT, undefined, db => sampleVitals(db, probe(8, 'heavy')))
    expect(beatOf(made.db, SUPERVISOR_BEAT)).toMatchObject({ vitals: { thermal: 'heavy' } })
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([{ reason: HOST_DEGRADED, cause: 'thermal', detail: expect.stringContaining('thermal pressure heavy') as unknown }])
  })

  it('the liveness judge beats with the vitals its root hands it, and a judge handed none samples no host', async () => {
    const sampled = bench()
    await new LivenessJudge(sampled.db, () => sampled.clock.now().getTime(), () => () => false, async () => [], undefined, db => sampleVitals(db, probe(8, 'heavy'))).step()
    expect(beatOf(sampled.db, SUPERVISOR_PROCESS)).toMatchObject({ vitals: { thermal: 'heavy' } })

    const unsampled = bench()
    await new LivenessJudge(unsampled.db, () => unsampled.clock.now().getTime(), () => () => false).step()
    expect(beatOf(unsampled.db, SUPERVISOR_PROCESS)).toEqual({ process: SUPERVISOR_PROCESS })
    expect(eventsOf(unsampled.db, BOARD_ALARM)).toEqual([])
  })
})
