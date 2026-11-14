import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import type { NodeStep, NodeSupply, ProcessIdentity } from '../../../core/node.js'
import type { QueuedTask } from '../../../core/queue.js'
import type { CardStart, CardStarter, ChildExit, QueuedCard, StartedCard } from '../../../nodes/launch/launch-executor.js'
import type { RowIdentity } from '../../../ports/process-table.js'
import type { DetachedLaunch, RunningProcess } from '../../../supervisor/bg.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../../src/card/parking.js'
import { textSha } from '../../../../src/card/text-sha.js'
import { BUS_DB_VARIABLE } from '../../../core/bus-path.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CHILD_ENDED, CHILD_STARTED, WORKER_STARTED } from '../../../core/events.js'
import { judgeHolders, leaseNext, leaseQueued } from '../../../core/lease.js'
import { ChildLog, GENERATION_VARIABLE, INSTANCE_VARIABLE, instanceOf, Node, recordWorkerIdentity, UNHANDED } from '../../../core/node.js'
import { keyOf, queueTask } from '../../../core/queue.js'
import { reduce } from '../../../core/reducer.js'
import { realAnswererTools } from '../../../nodes/answer/answerer.js'
import { spawnClient } from '../../../nodes/answer/duties/client.js'
import { continuedAndRecorded, LaunchExecutor } from '../../../nodes/launch/launch-executor.js'
import { psPgid, ShiftCardStarter, spawnDetached } from '../../../nodes/launch/launch-starter.js'
import { realReviewStart } from '../../../nodes/review/reviewer.js'
import { realTimedShell } from '../../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../../nodes/witness/witness-worker.js'
import { identityOf, OsProcessTable } from '../../../ports/process-table.js'
import { SetupTurns, withWorktreeAsync } from '../../../ports/worktree.js'
import { BUS_RUN_LAUNCH, handedIdentity, launchArgv, recordSpawned, runBusBg, runsBusEntryItself, spawnedActor, startDetached } from '../../../supervisor/bg.js'
import { busProjections, nodeSupply, recordOwnStart, workerIdentity } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { generationEnv, ownIdentity, tableIdentity } from '../../../supervisor/recorded-worker.js'
import { workerLaunches } from '../../../supervisor/workers.js'
import { eventsOf, mergeBench } from '../merge-bench.js'

const roots: string[] = []
const dbs: DatabaseSync[] = []
const groups: number[] = []
const table = new OsProcessTable()
const GENERATION = 'a'.repeat(40)
const WORKER_START_MS = 60_000

afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL')
    }
    catch {}
  }
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function bus(): { busDir: string, busPath: string, db: DatabaseSync } {
  const busDir = tempRoot('k1a-bus-')
  const busPath = path.join(busDir, 'bus.db')
  const db = openBus(busPath)
  dbs.push(db)
  return { busDir, busPath, db }
}

async function ownRecordOfRestart(db: DatabaseSync): Promise<Record<string, unknown>> {
  return vi.waitFor(() => {
    const own = started(db).find(record => String(record.worker).startsWith('worker:restart:'))
    expect(own, 'the restart worker records its own start').toBeDefined()
    return own!
  }, { timeout: WORKER_START_MS, interval: 100 })
}

function started(db: DatabaseSync): Record<string, unknown>[] {
  return eventsOf(db, WORKER_STARTED)
}

const noProcesses = (): RunningProcess[] => []

function sameIdentity(record: Record<string, unknown>, row: RowIdentity): boolean {
  return record.pid === row.pid && record.lstart === row.lstart
}

describe('k1a [needs ps]: a worker started through startDetached records its identity', () => {
  it('a worker started through startDetached records its identity', async () => {
    const { busDir, busPath, db } = bus()
    const env = { ...process.env, [BUS_DB_VARIABLE]: busPath, [GENERATION_VARIABLE]: GENERATION }
    const result = startDetached(workerLaunches(() => []).restart, busDir, env, noProcesses)
    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    const spawned = Number(result.stdout[0])
    groups.push(spawned)
    const row = identityOf(table.snapshot(), spawned)!
    const parent = started(db).find(record => record.pid === spawned)!
    expect(parent).toMatchObject({ pid: spawned, pgid: row.pgid, lstart: row.lstart, started: row.lstart, generation: GENERATION })
    expect(parent.worker).toBe(spawnedActor('bus:restart', String(parent.instance)))
    const own = await ownRecordOfRestart(db)
    const ownRow = identityOf(table.snapshot(), Number(own.pid))!
    expect(own).toMatchObject({ instance: parent.instance, generation: GENERATION, pgid: spawned, lstart: ownRow.lstart })
  }, WORKER_START_MS + 10_000)

  it('the parent record never throws after spawn(), even when the bus cannot take it', () => {
    const handed = handedIdentity({ [GENERATION_VARIABLE]: GENERATION }, 'instance-1')
    const broken = { snapshot: () => {
      throw new Error('the table broke')
    }, clientCwds: () => ({ kind: 'listed' as const, cwds: [] }), cpuSample: () => '' }
    const { busPath } = bus()
    expect(recordSpawned({ [BUS_DB_VARIABLE]: busPath }, 'bus:run', handed, process.pid, broken)).toBe(false)
    expect(recordSpawned({}, 'bus:run', handed, process.pid)).toBe(false)
    expect(handed).toEqual({ [INSTANCE_VARIABLE]: 'instance-1', [GENERATION_VARIABLE]: GENERATION })
    expect(handedIdentity({})[GENERATION_VARIABLE]).toBe(UNHANDED)
  })

  it('the spawned actor is one appendEvent admits', () => {
    const { busPath, db } = bus()
    const handed = handedIdentity({}, 'instance-2')
    expect(recordSpawned({ [BUS_DB_VARIABLE]: busPath }, 'bus:run', handed, process.pid)).toBe(true)
    expect(started(db)[0]).toMatchObject({ worker: 'worker:bus-run:instance-2', pid: process.pid })
  })
})

const WITNESS_CARD = 1927

class WitnessNodeOnOneLease extends WitnessNode {
  async handleOne(lease: Lease): Promise<unknown> {
    return this.handle(lease)
  }
}
const TS = '2026-11-14T10:00:00.000Z'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

describe('k1a [needs ps]: a witness command records its start and its true exit', () => {
  it('a witness command records its start and its true exit', async () => {
    const root = tempRoot('k1a-witness-')
    const repo = path.join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(path.join(repo, 'README.md'), 'base\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-q', '-m', 'base')
    const main = git(repo, 'rev-parse', 'HEAD')
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    const text = parkingFileText({ card: `#${WITNESS_CARD} k1a [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/k1a', touches: ['README.md'], continue: 'stop', who: 'shift', body: 'Touch README.md.\n\nWitnesses:\n- `sleep 1; exit 3` exits 0' })
    appendEvent(db, { ts: TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: WITNESS_CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${WITNESS_CARD}`, payload: { card: `#${WITNESS_CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
    reduce(db, 'pending', busProjections())
    const task: QueuedTask = { queue: 'witness', cardId: WITNESS_CARD, head: main }
    queueTask(db, TS, task)
    const lease = leaseQueued(db, TS, keyOf(task), 'worker:witness:k1a')!
    const seen: { identity: RowIdentity | null, tree: string | null } = { identity: null, tree: null }
    const turns = new SetupTurns()
    await new WitnessNodeOnOneLease({
      db,
      clock: () => new Date(TS),
      session: 'k1a',
      mode: 'live',
      env: process.env,
      silentMs: SILENT_MS,
      shell: (command, cwd, timeoutMs, onStart) => realTimedShell(command, cwd, timeoutMs, (pid) => {
        seen.identity = identityOf(table.snapshot(), pid)
        seen.tree = cwd
        onStart?.(pid)
      }),
      trees: { baseOf: async () => main, withTree: (base, run) => withWorktreeAsync(repo, base, run, turns) },
    }).handleOne(lease)
    const [child] = eventsOf(db, CHILD_STARTED)
    expect(seen.identity).not.toBeNull()
    expect(child).toEqual({ mode: 'child', ...instanceOf(process.env), pid: seen.identity!.pid, pgid: seen.identity!.pgid, lstart: seen.identity!.lstart, kind: 'witness', task_key: lease.taskKey, tree: seen.tree })
    expect(eventsOf(db, CHILD_ENDED)).toEqual([{ instance: instanceOf(process.env).instance, pid: seen.identity!.pid, task_key: lease.taskKey, exit: 3, signal: null }])
  }, 60_000)
})

const LAUNCH_CARD = 1928

class RealSessionStarter implements CardStarter {
  stopped: StartedCard[] = []
  identity: RowIdentity | null = null
  private endOf: () => void = () => {}
  readonly sessionEnded = new Promise<void>((resolve) => {
    this.endOf = resolve
  })

  constructor(private readonly root: string) {}

  readonly identify = (pid: number): ProcessIdentity | null => ShiftCardStarter.prototype.identify(pid)

  start(_card: QueuedCard, ended?: ChildExit): CardStart {
    const pid = spawnDetached({ command: 'sh', args: ['-c', 'sleep 1; exit 5'], cwd: this.root, env: process.env, input: '', log: path.join(this.root, 'session.log'), ended: (exit, signal) => {
      ended?.(exit, signal)
      this.endOf()
    } })
    groups.push(pid)
    this.identity = identityOf(table.snapshot(), pid)
    return { kind: 'started', card: { session: 'session-k1a', worktree: this.root, branch: 'feat/k1a', base: 'f'.repeat(40), pid, pgid: psPgid(pid) } }
  }

  stop(card: StartedCard): void {
    this.stopped.push(card)
  }
}

function launchBench(identity?: (pid: number) => RowIdentity | null) {
  const bench = mergeBench()
  const root = tempRoot('k1a-launch-')
  const starter = new RealSessionStarter(root)
  const executor = new LaunchExecutor({ silentMs: SILENT_MS, db: bench.db, starter, clock: bench.clock.now, disk: () => ({ bavail: 1e9, bsize: 4096 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), ...(identity === undefined ? {} : { identity }) })
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: LAUNCH_CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${LAUNCH_CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${LAUNCH_CARD}` }, legacy: false })
  bench.tick()
  const lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'launch', 'worker:launch:k1a')!
  return { bench, starter, executor, lease }
}

describe('k1a [needs ps]: a launch start records its session', () => {
  it('a launch start records its session and a failed record does not kill it', async () => {
    const { bench, starter, executor, lease } = launchBench()
    try {
      expect(executor.launch(lease).kind).toBe('started')
      const [child] = eventsOf(bench.db, CHILD_STARTED)
      expect(starter.identity).not.toBeNull()
      expect(child).toMatchObject({ mode: 'child', pid: starter.identity!.pid, pgid: starter.identity!.pgid, lstart: starter.identity!.lstart, kind: 'launch', task_key: lease.taskKey })
      await starter.sessionEnded
      const [ended] = eventsOf(bench.db, CHILD_ENDED)
      expect(ended).toMatchObject({ pid: starter.identity!.pid, task_key: lease.taskKey, exit: 5, signal: null })
    }
    finally {
      bench.close()
    }

    const failing = launchBench(() => {
      throw new Error('the process table broke')
    })
    try {
      expect(failing.executor.launch(failing.lease).kind).toBe('started')
      expect(failing.starter.stopped).toEqual([])
      expect(eventsOf(failing.bench.db, CARD_STARTED)).toHaveLength(1)
      expect(eventsOf(failing.bench.db, CHILD_STARTED)).toEqual([])
    }
    finally {
      failing.bench.close()
    }
  }, 30_000)
})

describe('k1a: worker.started keeps its fields', () => {
  it('worker.started only gains fields and its readers read it unchanged', () => {
    const bench = mergeBench()
    try {
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: LAUNCH_CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${LAUNCH_CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${LAUNCH_CARD}` }, legacy: false })
      bench.tick()
      const now = bench.clock.now().toISOString()
      const lease: Lease = leaseNext(bench.db, now, 'launch', 'worker:launch:k1a-reader')!
      const start = '2026-11-14T09:00:00.000Z'
      recordWorkerIdentity(bench.db, now, { worker: lease.actor, pid: 4242, started: start, instance: 'i-1', generation: GENERATION, pgid: 4242, lstart: '2026-11-14T09:00:01.000Z' })
      expect(started(bench.db)[0]).toMatchObject({ worker: lease.actor, pid: 4242, started: start, instance: 'i-1', generation: GENERATION, pgid: 4242 })
      expect(judgeHolders(bench.db, now, () => ({ state: 'running', started: start }), SILENT_MS).freed).toEqual([])
      expect(judgeHolders(bench.db, now, () => ({ state: 'gone' }), SILENT_MS).freed).toEqual([lease.taskKey])
    }
    finally {
      bench.close()
    }
  })
})

describe('k1a [needs ps]: every process the supervisor starts has exactly one live record', () => {
  it('every process the supervisor starts has exactly one live record matching the process table', async () => {
    const { busDir, busPath, db } = bus()
    const env = { ...process.env, [BUS_DB_VARIABLE]: busPath }
    const restart = workerLaunches(() => []).restart
    const busRunStandIn = ['nohup', 'sleep', '120']
    const result = runBusBg(busDir, [BUS_RUN_LAUNCH, restart], env, noProcesses, (launch: DetachedLaunch, dir, handedEnv, processes) => startDetached(launch, dir, generationEnv({ head: () => GENERATION }, handedEnv), processes, launch === BUS_RUN_LAUNCH ? { argv: busRunStandIn } : {}))
    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    const leaders = result.stdout.map(Number).filter(Number.isInteger)
    groups.push(...leaders)
    expect(leaders).toHaveLength(2)
    await ownRecordOfRestart(db)
    const snapshot = table.snapshot()
    const restartNode = Number(started(db).find(record => String(record.worker).startsWith('worker:restart:'))!.pid)
    for (const pid of [...leaders, restartNode]) {
      const row = identityOf(snapshot, pid)
      expect(row, `pid ${pid} is running`).not.toBeNull()
      expect(started(db).filter(record => sameIdentity(record, row!)), `pid ${pid}`).toHaveLength(1)
    }
    expect(started(db).every(record => record.generation === GENERATION)).toBe(true)
  }, WORKER_START_MS + 10_000)

  it('a bus entry started directly records itself, so the parent writes no second record', () => {
    const installed = launchArgv(BUS_RUN_LAUNCH, path.resolve('.'), undefined, {})
    expect(runsBusEntryItself(installed)).toBe(true)
    expect(runsBusEntryItself(launchArgv(BUS_RUN_LAUNCH, null))).toBe(false)
    const { db } = bus()
    expect(recordOwnStart(db, 'run', { [INSTANCE_VARIABLE]: 'run-1', [GENERATION_VARIABLE]: GENERATION })).toBe(true)
    const own = identityOf(table.snapshot(), process.pid)!
    expect(started(db)).toEqual([expect.objectContaining({ worker: 'worker:run:run-1', pid: process.pid, pgid: own.pgid, lstart: own.lstart, instance: 'run-1', generation: GENERATION })])
  })
})

class IdleNode extends Node<NodeStep> {
  protected candidates(): QueuedTask[] {
    return []
  }

  protected handle(): NodeStep {
    return { kind: 'idle' }
  }
}

describe('k1a [needs ps]: every record writer', () => {
  it('generationEnv hands the head, and unhanded when the head cannot be read', () => {
    expect(generationEnv({ head: () => GENERATION }, {})[GENERATION_VARIABLE]).toBe(GENERATION)
    expect(generationEnv({ head: () => {
      throw new Error('no git')
    } }, {})[GENERATION_VARIABLE]).toBe(UNHANDED)
  })

  it('node.identity takes pgid and lstart only from a table row of its own pid', () => {
    const { db } = bus()
    const own: ProcessIdentity = { pid: process.pid, pgid: 77, lstart: '2026-11-14T08:00:00.000Z' }
    const supply = (identity: ProcessIdentity): NodeSupply => ({ ...nodeSupply(), ownIdentity: () => identity })
    const parts = { db, clock: () => new Date(TS), session: 's', mode: 'shadow' as const, env: { [INSTANCE_VARIABLE]: 'n-1' }, silentMs: SILENT_MS }
    const proven = new IdleNode('merge', { ...parts, self: { pid: process.pid, started: TS }, supply: supply(own) }).identity()
    expect(proven).toMatchObject({ pid: process.pid, pgid: 77, lstart: own.lstart, instance: 'n-1', generation: UNHANDED, started: TS })
    const foreign = new IdleNode('merge', { ...parts, self: { pid: process.pid, started: TS }, supply: supply({ ...own, pid: process.pid + 1 }) }).identity()
    expect(foreign).toMatchObject({ pgid: null, lstart: TS })
  })

  it('composition.workerIdentity proves its row by pid and reads the real table by default', () => {
    const start = { pid: process.pid, started: TS }
    const own = ownIdentity()!
    expect(workerIdentity('worker:restart:r', start, { [INSTANCE_VARIABLE]: 'r-1' })).toMatchObject({ pid: process.pid, pgid: own.pgid, lstart: own.lstart, instance: 'r-1' })
    expect(workerIdentity('worker:restart:r', { pid: 1, started: TS }, {}, () => own)).toMatchObject({ pgid: null, lstart: TS })
    expect(tableIdentity(table)(process.pid)).toEqual(own)
  })
})

const FAKE_IDENTITY = (pid: number): ProcessIdentity => ({ pid, pgid: pid, lstart: TS })

function childLogOn(db: DatabaseSync, identity: (pid: number) => ProcessIdentity | null = FAKE_IDENTITY): ChildLog {
  return new ChildLog(write => write(db), identity, () => new Date(TS), { [INSTANCE_VARIABLE]: 'i-child', [GENERATION_VARIABLE]: GENERATION })
}

const RUN = { actor: 'worker:answer:k1a', taskKey: 'answer:1927:1:h', kind: 'answer', tree: '/trees/1927' }

describe('k1a: the answer, review and continued sessions record their child', () => {
  it('childLog.around records the start with its identity and the true exit, and the end even when the spawn throws', async () => {
    const { db } = bus()
    expect(await childLogOn(db).around(RUN, async (started) => {
      started(4242)
      return 7
    })).toBe(7)
    await expect(childLogOn(db).around({ ...RUN, taskKey: 'answer:1927:2:h' }, async (started) => {
      started(4343)
      throw new Error('the client broke')
    })).rejects.toThrow('the client broke')
    expect(eventsOf(db, CHILD_STARTED)).toEqual([
      { mode: 'child', instance: 'i-child', generation: GENERATION, pid: 4242, pgid: 4242, lstart: TS, kind: 'answer', task_key: RUN.taskKey, tree: RUN.tree },
      { mode: 'child', instance: 'i-child', generation: GENERATION, pid: 4343, pgid: 4343, lstart: TS, kind: 'answer', task_key: 'answer:1927:2:h', tree: RUN.tree },
    ])
    expect(eventsOf(db, CHILD_ENDED)).toEqual([
      { instance: 'i-child', pid: 4242, task_key: RUN.taskKey, exit: 7, signal: null },
      { instance: 'i-child', pid: 4343, task_key: 'answer:1927:2:h', exit: null, signal: null },
    ])
  })

  it('a child with no identity in the process table records neither start nor end', async () => {
    const { db } = bus()
    await childLogOn(db, () => null).around(RUN, async (started) => {
      started(4242)
      return 0
    })
    expect([eventsOf(db, CHILD_STARTED), eventsOf(db, CHILD_ENDED)]).toEqual([[], []])
  })

  it('the real answer and review tools carry a child log, and the node supply carries the identity reader the witness worker hands on', () => {
    const { busPath } = bus()
    expect(realAnswererTools(busPath).children).toBeInstanceOf(ChildLog)
    expect(realReviewStart(busPath).children).toBeInstanceOf(ChildLog)
    expect(nodeSupply().identityOf).toBeTypeOf('function')
  })

  it('a continued launch session records its start and its end', () => {
    const { db } = bus()
    const ends: ChildExit[] = []
    const continuer = {
      continueFrom: (_card: QueuedCard, from: StartedCard, ended?: ChildExit): CardStart => {
        ends.push(ended!)
        return { kind: 'started', card: { ...from, session: 'next', pid: 5151, pgid: 5151 } }
      },
      identify: FAKE_IDENTITY,
    }
    const from: StartedCard = { session: 'first', worktree: '/trees/1927', branch: 'feat/k1a', base: 'f'.repeat(40), pid: 5050, pgid: 5050, contour: 'cheap' }
    expect(continuedAndRecorded(db, 'worker:launch:k1a', 'card.started:1927:x', continuer, { cardId: 1927, lane: 'lane-a' }, from).kind).toBe('started')
    ends[0]!(2, null)
    expect(eventsOf(db, CHILD_STARTED)).toEqual([expect.objectContaining({ pid: 5151, kind: 'launch', task_key: 'continued:card.started:1927:x', tree: '/trees/1927' })])
    expect(eventsOf(db, CHILD_ENDED)).toEqual([expect.objectContaining({ pid: 5151, task_key: 'continued:card.started:1927:x', exit: 2 })])
  })
})

describe('k1a [needs ps]: a real answer session records its child', () => {
  it('spawnClient hands the pid of a real session, which records its table identity and its true exit', async () => {
    const { busDir, db } = bus()
    const log = new ChildLog(write => write(db), tableIdentity(table), () => new Date(TS), {})
    const seen: { identity: RowIdentity | null } = { identity: null }
    const code = await log.around(RUN, async started => spawnClient({ cwd: busDir, command: 'sh', argv: ['-c', 'sleep 1; exit 4'], stdoutPath: path.join(busDir, 'out.log'), stderrPath: path.join(busDir, 'err.log'), env: process.env, started: (pid) => {
      seen.identity = identityOf(table.snapshot(), pid)
      started(pid)
    } }))
    expect(code).toBe(4)
    expect(eventsOf(db, CHILD_STARTED)).toEqual([expect.objectContaining({ pid: seen.identity!.pid, pgid: seen.identity!.pgid, lstart: seen.identity!.lstart })])
    expect(eventsOf(db, CHILD_ENDED)).toEqual([expect.objectContaining({ pid: seen.identity!.pid, exit: 4 })])
  }, 30_000)
})
