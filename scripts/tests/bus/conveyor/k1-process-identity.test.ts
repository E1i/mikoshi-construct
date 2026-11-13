import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { ProcessRow, ProcessTable } from '../../../ports/process-table.js'
import type { BgResult } from '../../../supervisor/bg.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../../core/db.js'
import { CHILD_STARTED, MAIN_ADVANCED, WORKER_STARTED } from '../../../core/events.js'
import { FACTORY_WORKERS } from '../../../core/factory-paths.js'
import { childrenNotEnded, GENERATION_VARIABLE, INSTANCE_VARIABLE, recordChildEnded, recordChildStarted, recordedWorkers, recordWorkerIdentity } from '../../../core/node.js'
import { identityOf } from '../../../ports/process-table.js'
import { handedIdentity, PREFIX } from '../../../supervisor/bg.js'
import { identifiedProcesses } from '../../../supervisor/recorded-worker.js'
import { BusSupervisor, mainAdvancedSince, stopInstance, withoutRetiring } from '../../../supervisor/supervisor.js'
import { workerLaunches } from '../../../supervisor/workers.js'
import { waitFor } from '../../wait-for.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const CHILD_MS = 4_000
const ARRIVAL_MS = 15_000
const WORKER_ENTRY = FACTORY_WORKERS.launch
const WORKER_MARKER = `${WORKER_ENTRY} --on`

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

function payloadsOf(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
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
    const root = mkdtempSync(path.join(tmpdir(), 'conveyor-k1-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
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
    for (const kind of kinds) {
      expect(readFileSync(path.join(root, `${kind}.ended`), 'utf8')).toBe('0')
    }
    for (const [at, pid] of handed.pids.entries())
      recordChildEnded(db, ts(), actor, { instance: handed.instance, pid, taskKey: `${kinds[at]}:1852`, exit: 0, signal: null })
    expect(childrenNotEnded(db)).toEqual([])

    const [workerStart] = payloadsOf(db, WORKER_STARTED)
    expect(workerStart).toMatchObject({ worker: actor, pid: worker.pid, instance: handed.instance, generation: OLD_MAIN, pgid: worker.pid })
    expect(Date.parse(String(workerStart!.lstart))).not.toBeNaN()
    expect(recordedWorkers(db)).toEqual([expect.objectContaining({ instance: handed.instance, generation: OLD_MAIN, pid: worker.pid, pgid: worker.pid })])
    const childStarts = payloadsOf(db, CHILD_STARTED)
    expect(childStarts.map(each => ({ mode: each.mode, kind: each.kind, instance: each.instance, generation: each.generation, pid: each.pid, pgid: each.pgid }))).toEqual(handed.pids.map((pid, at) => ({ mode: 'child', kind: kinds[at], instance: handed.instance, generation: OLD_MAIN, pid, pgid: pid })))
    expect(childStarts.every(each => Date.parse(String(each.lstart)) > 0)).toBe(true)
    db.close()
  }, 30_000)

  it('a process the bus spawned is handed a fresh instance and the generation of its restart scope', () => {
    const first = handedIdentity({ [GENERATION_VARIABLE]: NEW_MAIN })
    const second = handedIdentity({ [GENERATION_VARIABLE]: NEW_MAIN })
    expect(first[GENERATION_VARIABLE]).toBe(NEW_MAIN)
    expect(first[INSTANCE_VARIABLE]).not.toBe(second[INSTANCE_VARIABLE])
    expect(handedIdentity({})[GENERATION_VARIABLE]).toBe('unhanded')
  })

  it('a pid reused by another process is not taken for the recorded worker', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conveyor-k1-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const table = spawnedTable([detachedRow(process.pid, new Date(Date.now() - 5_000), 'node vitest')])
    const own = identityOf(table.snapshot(), process.pid)!
    const earlier = new Date(Date.parse(own.lstart) - 60_000).toISOString()
    recordWorkerIdentity(db, new Date().toISOString(), { worker: 'worker:launch:reused', pid: own.pid, started: earlier, instance: 'reused', generation: OLD_MAIN, pgid: own.pgid, lstart: earlier })
    expect(identifiedProcesses(table, db)().map(each => each.pid)).toEqual([])
    recordWorkerIdentity(db, new Date().toISOString(), { worker: 'worker:launch:this', pid: own.pid, started: own.lstart, instance: 'this', generation: OLD_MAIN, pgid: own.pgid, lstart: own.lstart })
    expect(identifiedProcesses(table, db)().map(each => each.pid)).toEqual([own.pid])
    db.close()
  })
})
