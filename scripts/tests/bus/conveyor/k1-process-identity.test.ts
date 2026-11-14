import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { ProcessRow, ProcessTable } from '../../../ports/process-table.js'
import type { BgResult } from '../../../supervisor/bg.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE } from '../../../core/bus-path.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { CHILD_STARTED, MAIN_ADVANCED, WORKER_STARTED } from '../../../core/events.js'
import { FACTORY_RUNTIME, FACTORY_WORKERS } from '../../../core/factory-paths.js'
import { recordWorkerStarted } from '../../../core/lease.js'
import { GENERATION_VARIABLE, INSTANCE_VARIABLE, recordChildEnded, recordChildStarted, recordWorkerIdentity } from '../../../core/node.js'
import { realTimedShell } from '../../../nodes/witness/witness-executor.js'
import { BusRead } from '../../../ports/bus-read.js'
import { identityOf } from '../../../ports/process-table.js'
import { BUS_RUN_LAUNCH, handedIdentity, PREFIX, startDetached } from '../../../supervisor/bg.js'
import { childrenNotEnded, identifiedOnBus, identifiedProcesses, readableRows, recordedWorkers, runningAs, SAME_START_MS, sameStart } from '../../../supervisor/recorded-worker.js'
import { BusSupervisor, mainAdvancedSince, stopInstance, SUPERVISOR_LAUNCH, withoutRetiring } from '../../../supervisor/supervisor.js'
import { workerLaunches } from '../../../supervisor/workers.js'
import { waitFor } from '../../wait-for.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const CHILD_MS = 4_000
const ARRIVAL_MS = 15_000
const WORKER_ENTRY = FACTORY_WORKERS.launch
const WORKER_MARKER = `${WORKER_ENTRY} --on`
const BUS_RUN_COMMAND = `node --import tsx ${FACTORY_RUNTIME.busRunEntry}`

const CHILD = [
  `const { appendFileSync, writeFileSync } = require('node:fs')`,
  `const [ms, ended, signals] = process.argv.slice(1)`,
  `for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => appendFileSync(signals, name + '\\n'))`,
  `setTimeout(() => { writeFileSync(ended, '0'); process.exit(0) }, Number(ms))`,
].join('\n')

const WORKER = [
  `const { spawn } = require('node:child_process')`,
  `const [child, ms, dir, ...marker] = process.argv.slice(1)`,
  `const pids = ['launch', 'witness'].map((kind) => {`,
  `  const started = spawn(process.execPath, ['-e', child, ms, dir + '/' + kind + '.ended', dir + '/' + kind + '.signals', ...marker], { detached: true, stdio: 'ignore' })`,
  `  started.unref()`,
  `  return started.pid`,
  `})`,
  `console.log(JSON.stringify({ pids, instance: process.env.${INSTANCE_VARIABLE}, generation: process.env.${GENERATION_VARIABLE} }))`,
  `setInterval(() => {}, 1000)`,
].join('\n')

const roots: string[] = []
const spawned: ChildProcess[] = []

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function spawnedTable(rows: ProcessRow[]): ProcessTable {
  return {
    snapshot: () => ({ readable: true, rows: rows.filter(row => alive(row.pid)) }),
    clientCwds: () => ({ kind: 'unreadable', why: 'not read here' }),
    cpuSample: () => '',
  }
}

function detachedRow(pid: number, started: Date, command: string): ProcessRow {
  return { pid, ppid: 0, pgid: pid, started: started.toString(), command }
}

function freshBus(): { root: string, busPath: string, db: DatabaseSync } {
  const root = mkdtempSync(path.join(tmpdir(), 'conveyor-k1-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  return { root, busPath, db: openBus(busPath) }
}

function detachedSleep(): ChildProcess {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  child.unref()
  spawned.push(child)
  return child
}

interface Handed { pids: [number, number], instance: string, generation: string }

async function oldGeneration(root: string): Promise<{ worker: ChildProcess, handed: Handed, table: ProcessTable }> {
  const startedAt = new Date()
  const worker = spawn(process.execPath, ['-e', WORKER, CHILD, String(CHILD_MS), root, WORKER_MARKER], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...handedIdentity({ [GENERATION_VARIABLE]: OLD_MAIN }) } })
  spawned.push(worker)
  const lines = createInterface({ input: worker.stdout! })[Symbol.asyncIterator]()
  const first = await lines.next()
  if (first.done === true)
    throw new Error('the stand-in worker closed its output before naming its children')
  const handed = JSON.parse(first.value) as Handed
  const childrenAt = new Date()
  const table = spawnedTable([
    detachedRow(worker.pid!, startedAt, `node -e worker ${WORKER_MARKER}`),
    ...handed.pids.map(pid => detachedRow(pid, childrenAt, `node -e session ${CHILD_MS} ${WORKER_MARKER}`)),
  ])
  return { worker, handed, table }
}

describe('scenario 03 (K1): a restart stops workers by recorded identity only', () => {
  it('a real main.advanced stops the old worker by its identity, and its detached launch session and witness command are not signalled and end with their own status', async () => {
    const { root, db } = freshBus()
    const ts = (): string => new Date().toISOString()
    const { worker, handed, table } = await oldGeneration(root)
    const workerExit = once(worker, 'exit')
    const actor = `worker:launch:${handed.instance}`
    const snapshot = table.snapshot()
    const own = identityOf(snapshot, worker.pid!)!
    recordWorkerIdentity(db, ts(), { worker: actor, pid: own.pid, started: own.lstart, instance: handed.instance, generation: handed.generation, pgid: own.pgid, lstart: own.lstart })
    const kinds = ['launch', 'witness'] as const
    for (const [at, pid] of handed.pids.entries()) {
      const child = identityOf(snapshot, pid)!
      recordChildStarted(db, ts(), actor, { mode: 'child', instance: handed.instance, generation: handed.generation, ...child, kind: kinds[at]!, taskKey: `${kinds[at]}:1852`, tree: root })
    }
    appendEvent(db, { ts: ts(), type: MAIN_ADVANCED, actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `${MAIN_ADVANCED}:${NEW_MAIN}`, payload: { sha: NEW_MAIN }, legacy: false })

    const { launch } = workerLaunches(() => [])
    const processes = withoutRetiring(identifiedProcesses(table, db), db)
    let head = OLD_MAIN
    const started: string[] = []
    const supervisor = new BusSupervisor({
      known: [launch],
      wanted: () => [launch],
      start: (each): BgResult => {
        started.push(each.script)
        return { stdout: [`${PREFIX}started ${each.script}`], stderr: [], exitCode: 0 }
      },
      stop: running => stopInstance(running, processes),
      processes,
      mainSince: afterId => mainAdvancedSince(db, afterId),
      code: {
        head: () => head,
        holds: sha => sha === head,
        pull: () => {
          head = NEW_MAIN
        },
        changedSince: sha => sha === head ? [] : [WORKER_ENTRY],
        runs: () => new Set([WORKER_ENTRY]),
      },
      journal: () => {},
      now: () => Date.now(),
    }, 0)

    expect(processes().map(each => each.pid)).toEqual([worker.pid])
    await supervisor.step()
    const [workerCode, workerSignal] = await workerExit as [number | null, string | null]

    expect({ code: workerCode, signal: workerSignal }).toEqual({ code: null, signal: 'SIGTERM' })
    expect(started).toEqual(['bus:launch'])
    expect(handed.pids.every(alive)).toBe(true)
    const signalsOf = (kind: string): string => existsSync(path.join(root, `${kind}.signals`)) ? readFileSync(path.join(root, `${kind}.signals`), 'utf8') : ''
    expect(kinds.map(signalsOf)).toEqual(['', ''])
    await waitFor(() => handed.pids.every(pid => !alive(pid)), () => 'the detached children ending on their own', ARRIVAL_MS)
    for (const kind of kinds)
      expect(readFileSync(path.join(root, `${kind}.ended`), 'utf8')).toBe('0')
    for (const [at, pid] of handed.pids.entries())
      recordChildEnded(db, ts(), actor, { instance: handed.instance, pid, taskKey: `${kinds[at]}:1852`, exit: 0, signal: null })
    expect(childrenNotEnded(db)).toEqual([])

    const read = new BusRead(db)
    const [workerStart] = read.slice(WORKER_STARTED, ['worker', 'pid', 'instance', 'generation', 'pgid', 'lstart'])
    expect(workerStart!.fields).toMatchObject({ worker: actor, pid: worker.pid, instance: handed.instance, generation: OLD_MAIN, pgid: worker.pid })
    expect(Date.parse(String(workerStart!.fields.lstart))).not.toBeNaN()
    expect(recordedWorkers(db)).toEqual([expect.objectContaining({ instance: handed.instance, generation: OLD_MAIN, pid: worker.pid, pgid: worker.pid })])
    const childStarts = read.slice(CHILD_STARTED, ['mode', 'kind', 'instance', 'generation', 'pid', 'pgid', 'lstart']).map(each => each.fields)
    expect(childStarts.map(({ lstart: _lstart, ...each }) => each)).toEqual(handed.pids.map((pid, at) => ({ mode: 'child', kind: kinds[at], instance: handed.instance, generation: OLD_MAIN, pid, pgid: pid })))
    expect(childStarts.every(each => Date.parse(String(each.lstart)) > 0)).toBe(true)
    db.close()
  }, 30_000)

  it('a witness command runs as the leader of its own process group, so a signal to the group of its worker never reaches it', async () => {
    const { root } = freshBus()
    let runner: number | null = null
    let ownGroup = false
    const result = await realTimedShell('sleep 1', root, 10_000, (pid) => {
      runner = pid
      try {
        process.kill(-pid, 0)
        ownGroup = true
      }
      catch {}
    })
    expect(runner).not.toBeNull()
    expect(ownGroup).toBe(true)
    expect(result).toMatchObject({ status: 0, timedOut: false })
  })

  it('a process the bus spawned is handed a fresh instance and the generation of its restart scope', () => {
    const first = handedIdentity({ [GENERATION_VARIABLE]: NEW_MAIN })
    const second = handedIdentity({ [GENERATION_VARIABLE]: NEW_MAIN })
    expect(first[GENERATION_VARIABLE]).toBe(NEW_MAIN)
    expect(first[INSTANCE_VARIABLE]).not.toBe(second[INSTANCE_VARIABLE])
    expect(handedIdentity({})[GENERATION_VARIABLE]).toBe('unhanded')
  })

  it('a pid reused by another process is not taken for the recorded worker', () => {
    const { db } = freshBus()
    const table = spawnedTable([detachedRow(process.pid, new Date(Date.now() - 5_000), 'node vitest')])
    const own = identityOf(table.snapshot(), process.pid)!
    const earlier = new Date(Date.parse(own.lstart) - 60_000).toISOString()
    recordWorkerIdentity(db, new Date().toISOString(), { worker: 'worker:launch:reused', pid: own.pid, started: earlier, instance: 'reused', generation: OLD_MAIN, pgid: own.pgid, lstart: earlier })
    expect(identifiedProcesses(table, db)().map(each => each.pid)).toEqual([])
    recordWorkerIdentity(db, new Date().toISOString(), { worker: 'worker:launch:this', pid: own.pid, started: own.lstart, instance: 'this', generation: OLD_MAIN, pgid: own.pgid, lstart: own.lstart })
    expect(identifiedProcesses(table, db)().map(each => each.pid)).toEqual([own.pid])
    db.close()
  })

  it('a start within SAME_START_MS of the recorded one is the same process, and one outside it is not', () => {
    const at = new Date(Date.UTC(2026, 10, 15, 10, 0, 0))
    const table = spawnedTable([detachedRow(process.pid, at, 'node vitest')])
    expect(sameStart(at.toISOString(), new Date(at.getTime() + SAME_START_MS - 1).toISOString())).toBe(true)
    expect(sameStart(at.toISOString(), new Date(at.getTime() + SAME_START_MS).toISOString())).toBe(false)
    expect(runningAs(table.snapshot(), { pid: process.pid, lstart: at.toISOString() })?.pid).toBe(process.pid)
    expect(runningAs(table.snapshot(), { pid: process.pid, lstart: new Date(at.getTime() - SAME_START_MS).toISOString() })).toBeNull()
  })
})

describe('f2 (K1b): the stop reads the records and never starts a duplicate of a running process', () => {
  it('a bus:run recorded in the shape written before lstart existed is seen, so a start leaves it alone and a stop signals it', async () => {
    const { root, db } = freshBus()
    const sleeper = detachedSleep()
    const startedAt = new Date()
    const table = spawnedTable([detachedRow(sleeper.pid!, startedAt, BUS_RUN_COMMAND)])
    recordWorkerStarted(db, new Date().toISOString(), 'worker:run:before-lstart', { pid: sleeper.pid!, started: startedAt.toISOString() })
    const processes = identifiedProcesses(table, db)
    expect(processes().map(each => each.pid)).toEqual([sleeper.pid])

    const busDir = path.join(root, 'bus')
    mkdirSync(busDir)
    const start = startDetached(BUS_RUN_LAUNCH, busDir, {}, processes)
    expect(start.alreadyRunning?.pid).toBe(sleeper.pid)
    expect(start.exitCode).toBe(1)

    const exit = once(sleeper, 'exit')
    await stopInstance(start.alreadyRunning!, processes, async () => {})
    expect((await exit)[1]).toBe('SIGTERM')
    db.close()
  })

  it('a bus:run of this bus with no record at all is adopted into the record, so a start leaves it alone and a stop signals it', async () => {
    const { root, busPath, db } = freshBus()
    const sleeper = detachedSleep()
    const command = `${BUS_RUN_COMMAND} --bus ${busPath}`
    const table = spawnedTable([detachedRow(sleeper.pid!, new Date(), command)])
    expect(identifiedProcesses(table, db)()).toEqual([])
    const processes = identifiedProcesses(table, db, { bus: busPath, markers: [BUS_RUN_LAUNCH.markers] })
    expect(processes().map(each => each.pid)).toEqual([sleeper.pid])
    expect(recordedWorkers(db)).toEqual([expect.objectContaining({ worker: expect.stringMatching(/^worker:adopted:/), pid: sleeper.pid, pgid: sleeper.pid })])
    expect(identifiedProcesses(table, db)().map(each => each.pid)).toEqual([sleeper.pid])

    const busDir = path.join(root, 'bus')
    mkdirSync(busDir)
    const start = startDetached(BUS_RUN_LAUNCH, busDir, { [BUS_DB_VARIABLE]: busPath }, processes)
    expect(start.alreadyRunning?.pid).toBe(sleeper.pid)
    const exit = once(sleeper, 'exit')
    await stopInstance(start.alreadyRunning!, processes, async () => {})
    expect((await exit)[1]).toBe('SIGTERM')
    db.close()
  })

  it('a bus:run or supervisor started by hand against the default bus, with no --bus and no record, is adopted, so a start leaves it alone and a stop signals it', async () => {
    const { root, busPath, db } = freshBus()
    const [run, supervisor] = [detachedSleep(), detachedSleep()]
    const at = new Date()
    const table = spawnedTable([
      detachedRow(run.pid!, at, BUS_RUN_COMMAND),
      detachedRow(supervisor.pid!, at, `node --import tsx ${SUPERVISOR_LAUNCH.markers[0]} --supervise`),
    ])
    const processes = identifiedProcesses(table, db, { bus: busPath, markers: [BUS_RUN_LAUNCH.markers, SUPERVISOR_LAUNCH.markers] })
    expect(processes().map(each => each.pid).sort()).toEqual([run.pid, supervisor.pid].sort())
    expect(recordedWorkers(db).map(each => each.pid).sort()).toEqual([run.pid, supervisor.pid].sort())

    const busDir = path.join(root, 'bus')
    mkdirSync(busDir)
    for (const [launch, sleeper] of [[BUS_RUN_LAUNCH, run], [SUPERVISOR_LAUNCH, supervisor]] as const) {
      const start = startDetached(launch, busDir, { [BUS_DB_VARIABLE]: busPath }, processes)
      expect(start.alreadyRunning?.pid).toBe(sleeper.pid)
      const exit = once(sleeper, 'exit')
      await stopInstance(start.alreadyRunning!, processes, async () => {})
      expect((await exit)[1]).toBe('SIGTERM')
    }
    db.close()
  })

  it('an unrecorded process of another bus, of no bus launch, or a running child is not adopted', () => {
    const { busPath, db } = freshBus()
    const [other, foreign, child] = [detachedSleep(), detachedSleep(), detachedSleep()]
    const at = new Date()
    const table = spawnedTable([
      detachedRow(other.pid!, at, `${BUS_RUN_COMMAND} --bus /elsewhere/bus.db`),
      detachedRow(foreign.pid!, at, `sleep 30 --bus ${busPath}`),
      detachedRow(child.pid!, at, `${BUS_RUN_COMMAND} --bus ${busPath}`),
    ])
    const lstart = identityOf(table.snapshot(), child.pid!)!.lstart
    recordChildStarted(db, new Date().toISOString(), 'worker:launch:k1b', { mode: 'child', instance: 'k1b', generation: OLD_MAIN, pid: child.pid!, pgid: child.pid!, lstart, kind: 'launch', taskKey: 'launch:1', tree: null })
    expect(identifiedProcesses(table, db, { bus: busPath, markers: [BUS_RUN_LAUNCH.markers] })()).toEqual([])
    expect(recordedWorkers(db)).toEqual([])
    db.close()
  })

  it('one process recorded twice, by its spawner and by itself, is listed once', () => {
    const { db } = freshBus()
    const sleeper = detachedSleep()
    const table = spawnedTable([detachedRow(sleeper.pid!, new Date(), BUS_RUN_COMMAND)])
    const own = identityOf(table.snapshot(), sleeper.pid!)!
    for (const worker of ['worker:bus-run:k1b', 'worker:run:k1b'])
      recordWorkerIdentity(db, new Date().toISOString(), { worker, pid: own.pid, started: own.lstart, instance: 'k1b', generation: OLD_MAIN, pgid: own.pgid, lstart: own.lstart })
    expect(recordedWorkers(db)).toHaveLength(2)
    expect(identifiedProcesses(table, db)()).toEqual([{ pid: sleeper.pid, group: sleeper.pid, args: BUS_RUN_COMMAND }])
    db.close()
  })
})

describe('f4 (K1b): identifiedProcesses and identifiedOnBus', () => {
  it('a recorded worker whose pid a running child of the bus holds is not listed as a worker', () => {
    const { db } = freshBus()
    const sleeper = detachedSleep()
    const startedAt = new Date()
    const table = spawnedTable([detachedRow(sleeper.pid!, startedAt, `node -e session ${WORKER_MARKER}`)])
    const lstart = identityOf(table.snapshot(), sleeper.pid!)!.lstart
    recordWorkerIdentity(db, new Date().toISOString(), { worker: 'worker:launch:shared', pid: sleeper.pid!, started: lstart, instance: 'shared', generation: OLD_MAIN, pgid: sleeper.pid!, lstart })
    expect(identifiedProcesses(table, db)().map(each => each.pid)).toEqual([sleeper.pid])
    recordChildStarted(db, new Date().toISOString(), 'worker:launch:other', { mode: 'child', instance: 'other', generation: OLD_MAIN, pid: sleeper.pid!, pgid: sleeper.pid!, lstart, kind: 'launch', taskKey: 'launch:1', tree: null })
    expect(identifiedProcesses(table, db)()).toEqual([])
    recordChildEnded(db, new Date().toISOString(), 'worker:launch:other', { instance: 'other', pid: sleeper.pid!, taskKey: 'launch:1', exit: 0, signal: null })
    expect(identifiedProcesses(table, db)().map(each => each.pid)).toEqual([sleeper.pid])
    db.close()
  })

  it('identifiedOnBus reads the records of the bus it is pointed at, each time it is asked, with the group of each process', () => {
    const { busPath, db } = freshBus()
    const sleeper = detachedSleep()
    const startedAt = new Date()
    const table = spawnedTable([detachedRow(sleeper.pid!, startedAt, `${BUS_RUN_COMMAND} --bus ${busPath}`)])
    const onBus = identifiedOnBus(() => busPath, table)
    expect(onBus()).toEqual([])
    recordWorkerStarted(db, new Date().toISOString(), 'worker:run:before-lstart', { pid: sleeper.pid!, started: startedAt.toISOString() })
    expect(onBus()).toEqual([{ pid: sleeper.pid, group: sleeper.pid, args: `${BUS_RUN_COMMAND} --bus ${busPath}`, bus: busPath }])
    db.close()
  })

  it('the whole table read for the lines about another package lists every row with its bus, and an unreadable table lists none', () => {
    const rows: ProcessRow[] = [detachedRow(4242, new Date(), `${BUS_RUN_COMMAND} --bus /x/bus.db`), detachedRow(4343, new Date(), 'sleep 30')]
    const readable: ProcessTable = { snapshot: () => ({ readable: true, rows }), clientCwds: () => ({ kind: 'listed', cwds: [] }), cpuSample: () => '' }
    const unreadable: ProcessTable = { snapshot: () => ({ readable: false, reason: 'ps refused' }), clientCwds: () => ({ kind: 'listed', cwds: [] }), cpuSample: () => '' }
    expect(readableRows(readable)()).toEqual([{ pid: 4242, args: `${BUS_RUN_COMMAND} --bus /x/bus.db`, bus: '/x/bus.db' }, { pid: 4343, args: 'sleep 30' }])
    expect(readableRows(unreadable)()).toEqual([])
  })

  it('an unreadable process table is an error, not an empty bus', () => {
    const { db } = freshBus()
    const table: ProcessTable = { snapshot: () => ({ readable: false, reason: 'ps refused' }), clientCwds: () => ({ kind: 'listed', cwds: [] }), cpuSample: () => '' }
    expect(() => identifiedProcesses(table, db)()).toThrow(/ps refused/)
    db.close()
  })
})
