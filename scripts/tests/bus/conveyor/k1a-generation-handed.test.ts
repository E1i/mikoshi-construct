import type { DatabaseSync } from 'node:sqlite'
import type { ProcessTable } from '../../../ports/process-table.js'
import type { BgResult, DetachedLaunch } from '../../../supervisor/bg.js'
import type { BusSupervisor, WorkerKeeper } from '../../../supervisor/supervisor.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE } from '../../../core/bus-path.js'
import { openBus } from '../../../core/db.js'
import { WORKER_STARTED } from '../../../core/events.js'
import { GENERATION_VARIABLE, UNHANDED } from '../../../core/node.js'
import { handedIdentity, recordSpawned, spawnedActor } from '../../../supervisor/bg.js'
import { runStart } from '../../../supervisor/start.js'
import { gitCode, relaunchSupervisor, startBus, superviseUntilReplaced, SUPERVISOR_LAUNCH } from '../../../supervisor/supervisor.js'
import { eventsOf } from '../merge-bench.js'

const GENERATION = 'b'.repeat(40)
const STARTED_PID = 4242
const STARTED_AT = 'Sat Nov 14 10:00:00 2026'
const roots: string[] = []
const dbs: DatabaseSync[] = []

const startedTable: ProcessTable = {
  snapshot: () => ({ readable: true, rows: [{ pid: STARTED_PID, ppid: 1, pgid: STARTED_PID, started: STARTED_AT, command: 'node bus' }] }),
  clientCwds: () => ({ kind: 'listed', cwds: [] }),
  cpuSample: () => '',
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function unhandedBus(): { busDir: string, db: DatabaseSync } {
  const busDir = mkdtempSync(path.join(tmpdir(), 'k1a-handed-'))
  roots.push(busDir)
  const busPath = path.join(busDir, 'bus.db')
  const db = openBus(busPath)
  dbs.push(db)
  vi.stubEnv(BUS_DB_VARIABLE, busPath)
  vi.stubEnv(GENERATION_VARIABLE, UNHANDED)
  return { busDir, db }
}

function recordedStart(launch: DetachedLaunch, _busDir: string, env: NodeJS.ProcessEnv): BgResult {
  const recorded = recordSpawned(env, launch.script, handedIdentity(env), STARTED_PID, startedTable)
  return recorded ? { stdout: [String(STARTED_PID)], stderr: [], exitCode: 0 } : { stdout: [], stderr: [`${launch.script} not recorded`], exitCode: 1 }
}

function supervisorRecords(db: DatabaseSync): Record<string, unknown>[] {
  return eventsOf(db, WORKER_STARTED).filter(record => String(record.worker).startsWith(spawnedActor(SUPERVISOR_LAUNCH.script, '')))
}

describe('k1a: the supervisor hands the generation to what it starts itself', () => {
  it('the supervisor restart of itself starts with a real generation', async () => {
    const { busDir, db } = unhandedBus()
    const printed: string[] = []
    await superviseUntilReplaced({
      supervisor: { step: async () => [], ownCodeBehind: GENERATION } as unknown as BusSupervisor,
      keeper: { step: () => [] } as unknown as WorkerKeeper,
      relaunch: { busDir, start: recordedStart },
      print: line => printed.push(line),
      pause: async () => {
        throw new Error(printed.join('\n'))
      },
    })
    expect(supervisorRecords(db)).toEqual([expect.objectContaining({ pid: STARTED_PID, generation: GENERATION })])
  })

  it('bus:bg starts with a real generation', async () => {
    expect(relaunchSupervisor, 'a build whose startBus takes no start would spawn real bus processes here').toBeTypeOf('function')
    const { busDir, db } = unhandedBus()
    const result = await startBus(busDir, () => [], undefined, recordedStart)
    expect(result.exitCode, [...result.stdout, ...result.stderr].join('\n')).toBe(0)
    expect(supervisorRecords(db)).toEqual([expect.objectContaining({ pid: STARTED_PID, generation: gitCode(process.cwd()).head() })])
    expect(eventsOf(db, WORKER_STARTED).map(record => record.generation)).not.toContain(UNHANDED)
  })

  it('construct-factory start hands the bus processes the generation of its repository', async () => {
    expect(relaunchSupervisor, 'a build whose runStart takes no spawn would spawn real bus processes here').toBeTypeOf('function')
    const { busDir, db } = unhandedBus()
    const repository = process.cwd()
    const result = await runStart(repository, 'mikoshi-construct', {
      platform: 'linux',
      home: busDir,
      uid: 0,
      path: '',
      busDb: path.join(busDir, 'bus.db'),
      busDir,
      launchctl: () => ({ status: 1, stderr: '' }),
      env: {},
      gh: args => ({ kind: 'failed', cause: 'failed', reason: `no gh in this test: ${args.join(' ')}`, stdout: '', stderr: '', attempts: 1 }),
      processes: () => [],
      spawn: recordedStart,
    })
    expect(result.exitCode, [...result.stdout, ...result.stderr].join('\n')).toBe(0)
    expect(supervisorRecords(db)).toEqual([expect.objectContaining({ pid: STARTED_PID, generation: gitCode(repository).head() })])
    expect(eventsOf(db, WORKER_STARTED).map(record => record.generation)).not.toContain(UNHANDED)
  })
})
