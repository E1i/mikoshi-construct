import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { ProcessRow, ProcessTable } from '../../ports/process-table.js'
import type { BgResult } from '../../supervisor/bg.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../core/db.js'
import { CARD_ANSWERED, TASK_RELEASED } from '../../core/events.js'
import { FACTORY_WORKERS } from '../../core/factory-paths.js'
import { completeTask, leaseWhileFree, recordWorkerStarted, RESTART_CUT } from '../../core/lease.js'
import { keyOf } from '../../core/queue.js'
import { AnswerOutcomes } from '../../nodes/answer/duties/outcomes.js'
import { BUS_RUN_LAUNCH, PREFIX } from '../../supervisor/bg.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { busDrain, BusSupervisor, groupedPsList, stopInstance, withoutRetiring } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const SESSION_MS = 2500
const PROMPT_NAMING_THE_RUN_ENTRY = 'card body: the restart touches scripts/supervisor/run.ts and scripts/core/db.ts'

const WORKER = `
const { spawn } = require('node:child_process')
const [sessionMs] = process.argv.slice(1)
const prompt = process.env.ANSWER_PROMPT
const session = spawn(process.execPath, ['-e', 'setTimeout(() => {}, Number(process.argv[1]))', sessionMs, prompt], { stdio: 'ignore' })
process.stdout.write(String(session.pid) + '\\n')
session.on('close', (code, signal) => {
  process.stdout.write(JSON.stringify({ code, signal }) + '\\n', () => process.exit(0))
})
`

const BUS_RUN = 'setInterval(() => {}, 1000)'

const spawned: ChildProcess[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function detached(args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env })
  spawned.push(child)
  return child
}

function linesOf(child: ChildProcess): () => Promise<string> {
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  return async () => {
    const next = await lines.next()
    if (next.done === true)
      throw new Error(`pid ${child.pid} closed its output before the line the test awaits`)
    return next.value
  }
}

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

const releasedFor = (db: DatabaseSync): unknown[] => db.prepare('SELECT json_extract(payload, \'$.reason\') AS reason FROM events WHERE type = ?').all(TASK_RELEASED)

describe('a restart signal spares the session of a retiring answer worker', () => {
  it('stopping bus:run while an answer session whose prompt names its entry is live on a retiring worker sends the session no signal', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'restart-signal-spares-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const ts = (): string => new Date().toISOString()
    const worker = detached(['-e', WORKER, String(SESSION_MS)], { ...process.env, ANSWER_PROMPT: PROMPT_NAMING_THE_RUN_ENTRY })
    const fromWorker = linesOf(worker)
    const busRun = detached(['-e', BUS_RUN, BUS_RUN_LAUNCH.markers[0]!])
    const busRunExit = once(busRun, 'exit')
    const sessionPid = Number(await fromWorker())
    const sessionFirst = groupedPsList(spawnedTable([
      { pid: sessionPid, ppid: worker.pid!, pgid: worker.pid!, started: '', command: `node -e session ${SESSION_MS} ${PROMPT_NAMING_THE_RUN_ENTRY}` },
      { pid: worker.pid!, ppid: process.pid, pgid: worker.pid!, started: '', command: `node --import tsx ${FACTORY_WORKERS.answer} --on` },
      { pid: busRun.pid!, ppid: process.pid, pgid: busRun.pid!, started: '', command: `node -e bus ${BUS_RUN_LAUNCH.markers[0]!}` },
    ]))

    const { answer } = workerLaunches(() => [])
    recordWorkerStarted(db, ts(), 'worker:answer:old', { pid: worker.pid!, started: ts() })
    const lease = leaseWhileFree(db, ts(), { queue: 'answer', cardId: 1852 }, 'worker:answer:old', 2)!
    const drain = busDrain(db, ts)
    expect(drain.retire(answer, [worker.pid!], NEW_MAIN, OLD_MAIN)).toEqual([lease.taskKey])

    const processes = withoutRetiring(sessionFirst, db)
    let head = OLD_MAIN
    const supervisor = new BusSupervisor({
      known: [BUS_RUN_LAUNCH],
      wanted: () => [BUS_RUN_LAUNCH],
      start: (): BgResult => ({ stdout: [`${PREFIX}started`], stderr: [], exitCode: 0 }),
      stop: running => stopInstance(running, processes),
      drain,
      processes,
      mainSince: () => [{ id: 1, sha: NEW_MAIN }],
      code: {
        head: () => head,
        holds: sha => sha === head,
        pull: () => {
          head = NEW_MAIN
        },
        changedSince: sha => sha === head ? [] : [SHARED_FILE],
        runs: () => new Set([SHARED_FILE]),
      },
      journal: () => {},
      now: () => Date.now(),
    }, 0)

    await supervisor.step()
    await busRunExit
    const ended = JSON.parse(await fromWorker()) as { code: number | null, signal: string | null }
    const outcomes = new AnswerOutcomes({ silentMs: SILENT_MS, db, clock: () => new Date(), ownerMerges: () => '' }, { pathsIn: () => [], ownerBoundary: () => undefined, wideningAsked: () => [] })
    if (ended.code === 0)
      completeTask(db, ts(), lease, [{ ts: ts(), type: CARD_ANSWERED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_ANSWERED}:${lease.taskKey}`, payload: { head: 'the-push' }, legacy: false }])
    else
      outcomes.denied(lease, { kind: 'technical', reason: 'answer_failed', detail: `the session exited ${ended.code ?? ended.signal}` })

    expect(ended).toEqual({ code: 0, signal: null })
    expect(db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(keyOf({ queue: 'answer', cardId: 1852 }))).toEqual({ state: 'completed' })
    expect(releasedFor(db)).not.toContainEqual({ reason: RESTART_CUT })
    db.close()
  }, 30_000)
})
