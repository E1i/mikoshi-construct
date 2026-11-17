import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { Queue } from '../../../core/identifiers.js'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../../core/db.js'
import { CHILD_ENDED, CHILD_STARTED, GENERATION_ENDED, PR_OBSERVED, SIGNAL_SENT, TASK_COMPLETED, TASK_LEASED, TASK_RELEASED, WORKER_STARTED } from '../../../core/events.js'
import { aliveBy, heldByLiveExecutors, leaseHandedOver, prTree, releaseUnstarted, RETIRED_UNSTARTED } from '../../../core/handover.js'
import { taskKey } from '../../../core/identifiers.js'
import { expireLeases, leaseNext, retireHolders } from '../../../core/lease.js'
import { eventsIn, GENERATION_VARIABLE, INSTANCE_VARIABLE, recordChildEnded, recordChildStarted, recordWorkerIdentity } from '../../../core/node.js'
import { queueTask } from '../../../core/queue.js'
import { reduce } from '../../../core/reducer.js'
import { BusRead } from '../../../ports/bus-read.js'
import { InMemoryProcessTable, OsProcessTable } from '../../../ports/process-table.js'
import { busProjections } from '../../../supervisor/composition.js'
import { generationsEnded } from '../../../supervisor/generation-handover.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { tableIdentity } from '../../../supervisor/recorded-worker.js'
import { livesIn } from '../../../supervisor/supervisor.js'
import { waitFor as waitWithin } from '../../wait-for.js'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const OLD_GENERATION = 'a'.repeat(40)
const NEW_GENERATION = 'b'.repeat(40)
const SCENARIO_MS = 90_000
const WAIT_MS = 45_000
const FAR_FUTURE = '2999-01-01T00:00:00.000Z'
const HELPER_PIDS = 'helpers.pids'
const HELPER_POLL_S = 0.05
const HELPER_BOUND_TICKS = Math.ceil(SCENARIO_MS / 1000 / HELPER_POLL_S)
const HELPER_OUT_OF_TIME = 124

const WORKER = `
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { openBus } from '${ROOT}/scripts/core/db.ts'
import { assertHeld, completeTask, StaleLease } from '${ROOT}/scripts/core/lease.ts'
import { busWriteAt, ChildLog, Node } from '${ROOT}/scripts/core/node.ts'
import { ownIdentity, tableIdentity } from '${ROOT}/scripts/supervisor/recorded-worker.ts'

const config = JSON.parse(process.env.K3_WORKER)

function fencedOr(lease, write) {
  try {
    return write()
  }
  catch (error) {
    if (error instanceof StaleLease)
      return { kind: 'fenced', taskKey: lease.taskKey }
    throw error
  }
}

class StandInNode extends Node {
  candidates() {
    return []
  }

  async handle(lease) {
    const card = String(lease.cardId)
    if (config.defer.includes(lease.cardId))
      return this.deferred(lease)
    if (config.inline[card] !== undefined) {
      const ran = spawnSync(config.inline[card][0], config.inline[card].slice(1), { stdio: 'ignore' })
      return this.completed(lease, ran.status)
    }
    const session = config.sessions[card]
    if (session === undefined)
      return this.completed(lease, 0)
    const log = new ChildLog(busWriteAt(config.bus), tableIdentity(), () => new Date(), process.env)
    const code = await log.around({ actor: this.actor, taskKey: lease.taskKey, kind: config.kind, tree: session.tree }, started => new Promise((resolve) => {
      const child = spawn(session.command[0], session.command.slice(1), { detached: session.detached, stdio: 'ignore' })
      appendFileSync(config.helpers, String(child.pid) + '\\n')
      const signalled = started(child.pid)
      child.on('close', (exit, signal) => {
        if (signal !== null)
          signalled(signal)
        resolve(exit ?? 1)
      })
    }))
    return this.completed(lease, code)
  }

  async deferred(lease) {
    for (;;) {
      const fenced = fencedOr(lease, () => assertHeld(this.db, lease))
      if (fenced !== undefined)
        return fenced
      await sleep(50)
    }
  }

  completed(lease, code) {
    if (code !== 0)
      return { kind: 'failed', taskKey: lease.taskKey }
    return fencedOr(lease, () => {
      completeTask(this.db, new Date().toISOString(), lease, [])
      return { kind: 'completed', taskKey: lease.taskKey }
    })
  }
}

const own = ownIdentity()
const supply = {
  cadence: { checkMs: 50, tickMs: 50 },
  recordProcessHeartbeat: () => {},
  slotsOf: () => 2,
  ownStart: () => ({ pid: process.pid, started: own === null ? new Date().toISOString() : new Date(Date.parse(own.lstart)).toISOString() }),
  ownIdentity: () => ownIdentity(),
  identityOf: tableIdentity(),
  refuses: () => null,
}
const node = new StandInNode(config.kind, { db: openBus(config.bus), clock: () => new Date(), session: config.session, mode: 'live', env: process.env, silentMs: 600000, supply })
await node.run({ pause: ms => sleep(ms), supply })
process.exit(0)
`

const table = new OsProcessTable()
const alive = aliveBy(tableIdentity(table))
const spawned: ChildProcess[] = []
const roots: string[] = []
const dbs: DatabaseSync[] = []

function killGroup(pid: number): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
    }
    catch {}
  }
}

function helperLoop(then: string, ticks = HELPER_BOUND_TICKS): string {
  return `n=0; while [ ! -f "$0" ]; do n=$((n+1)); [ "$n" -gt ${ticks} ] && exit ${HELPER_OUT_OF_TIME}; sleep ${HELPER_POLL_S}; done; ${then}`
}

function endHelpers(root: string): void {
  const listed = path.join(root, HELPER_PIDS)
  if (!existsSync(listed))
    return
  for (const pid of readFileSync(listed, 'utf8').split('\n').filter(line => line !== '').map(Number))
    killGroup(pid)
}

function endScenario(): void {
  for (const child of spawned.splice(0))
    killGroup(child.pid!)
  for (const root of roots)
    endHelpers(root)
}

afterEach(() => {
  endScenario()
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=k3', '-c', 'user.email=k3', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function workerLogs(): string {
  return roots.flatMap(root => readdirSync(root).filter(file => file.endsWith('.log')).map(file => `${file}:\n${readFileSync(path.join(root, file), 'utf8')}`)).join('\n')
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
  await waitWithin(ready, () => `${what}; the workers wrote:\n${workerLogs()}`, WAIT_MS)
}

interface Session {
  command: string[]
  tree: string
  detached: boolean
}

interface WorkerConfig {
  kind: Queue
  session: string
  defer?: number[]
  sessions?: Record<number, Session>
  inline?: Record<number, string[]>
}

interface Worker {
  process: ChildProcess
  actor: string
  instance: string
  log: string
  exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
}

class World {
  readonly root = mkdtempSync(path.join(tmpdir(), 'k3-handover-'))
  readonly bus = path.join(this.root, 'bus.db')
  readonly remote = path.join(this.root, 'remote.git')
  readonly main = path.join(this.root, 'main')
  readonly pushLog = path.join(this.root, 'pushes.log')
  readonly worker = path.join(this.root, 'worker.mts')
  readonly helpers = path.join(this.root, HELPER_PIDS)
  readonly db: DatabaseSync

  constructor() {
    roots.push(this.root)
    this.db = openBus(this.bus)
    dbs.push(this.db)
    writeFileSync(this.worker, WORKER)
    git(this.root, 'init', '-q', '--bare', this.remote)
    const hook = path.join(this.remote, 'hooks', 'post-receive')
    writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "$ref $new" >> "${this.pushLog}"; done\n`)
    chmodSync(hook, 0o755)
    git(this.root, 'clone', '-q', this.remote, this.main)
    git(this.main, 'commit', '-q', '--allow-empty', '-m', 'base')
    git(this.main, 'push', '-q', 'origin', 'HEAD:main')
    writeFileSync(this.pushLog, '')
  }

  tree(branch: string): string {
    const tree = path.join(this.root, 'trees', branch)
    mkdirSync(path.dirname(tree), { recursive: true })
    git(this.main, 'worktree', 'add', '-q', '-b', branch, tree)
    return tree
  }

  release(name: string): string {
    return path.join(this.root, `release-${name}`)
  }

  open(name: string): void {
    writeFileSync(this.release(name), '')
  }

  session(card: number, detached = false): Session {
    const tree = this.tree(`card-${card}`)
    const script = helperLoop('git -C "$1" -c user.name=k3 -c user.email=k3 commit -q --allow-empty -m "round of $2" && git -C "$1" push -q origin HEAD')
    return { command: ['sh', '-c', script, this.release(String(card)), tree, String(card)], tree, detached }
  }

  pushes(): string[] {
    return readFileSync(this.pushLog, 'utf8').split('\n').filter(line => line !== '')
  }

  remoteHead(branch: string): string {
    return git(this.root, '--git-dir', this.remote, 'rev-parse', `refs/heads/${branch}`)
  }

  start(generation: string, config: WorkerConfig): Worker {
    const instance = `${config.kind}-${config.session}`
    const env = { ...process.env, K3_WORKER: JSON.stringify({ defer: [], sessions: {}, inline: {}, ...config, bus: this.bus, helpers: this.helpers }), [INSTANCE_VARIABLE]: instance, [GENERATION_VARIABLE]: generation }
    const log = path.join(this.root, `${config.session}.log`)
    const output = openSync(log, 'a')
    const child = spawn(process.execPath, ['--import', 'tsx', this.worker], { cwd: ROOT, env, detached: true, stdio: ['ignore', output, output] })
    closeSync(output)
    spawned.push(child)
    const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    return { process: child, actor: `worker:${config.kind}:${config.session}`, instance, log, exited }
  }

  leftItsLoop(worker: Worker): boolean {
    return readFileSync(worker.log, 'utf8').includes(`${worker.actor} is retiring`)
  }

  queue(queue: Queue, cardId: number, pr?: { pr: number, head: string }): string {
    const task = { queue, cardId, ...pr }
    queueTask(this.db, new Date().toISOString(), task)
    return taskKey(task)
  }

  observe(cardId: number, pr: number, head: string): void {
    appendEvent(this.db, { ts: new Date().toISOString(), type: PR_OBSERVED, actor: 'netwatch', cardId, pr, head, dedupeKey: `${PR_OBSERVED}:${pr}:${head}`, payload: { card_id: cardId, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
    reduce(this.db, 'pending', busProjections())
  }

  retire(node: string, worker: Worker): string[] {
    return retireHolders(this.db, new Date().toISOString(), { node, pids: [worker.process.pid!], sha: NEW_GENERATION, from: OLD_GENERATION })
  }

  read(): BusRead {
    return new BusRead(this.db)
  }

  leasedBy(key: string): string[] {
    return this.read().slice(TASK_LEASED, ['task_key']).filter(each => each.fields.task_key === key).map(each => String(each.actor))
  }

  completedBy(key: string): string | null {
    return this.read().slice(TASK_COMPLETED, ['task_key']).find(each => each.fields.task_key === key)?.actor ?? null
  }

  childStarted(key: string): { id: number, fields: Record<string, unknown> } | undefined {
    return this.read().slice(CHILD_STARTED, ['mode', 'pid', 'lstart', 'task_key', 'tree', 'instance', 'generation', 'kind']).find(each => each.fields.task_key === key)
  }

  childEnded(key: string): { id: number, fields: Record<string, unknown> } | undefined {
    return this.read().slice(CHILD_ENDED, ['task_key', 'exit', 'signal', 'pid']).find(each => each.fields.task_key === key)
  }

  workerStarted(actor: string): Record<string, unknown> | undefined {
    return this.read().where({ actor }).slice(WORKER_STARTED, ['pid', 'generation', 'instance', 'lstart']).at(-1)?.fields
  }

  signalsSent(): number {
    return this.read().slice(SIGNAL_SENT, ['pid']).length
  }

  generationEnded(): { id: number, generation: unknown }[] {
    return this.read().slice(GENERATION_ENDED, ['generation']).map(each => ({ id: each.id, generation: each.fields.generation }))
  }

  endGenerations(): string[] {
    return generationsEnded(this.db, new Date().toISOString(), livesIn(table)())
  }
}

function expectLiveIdentity(world: World, worker: Worker, generation: string): void {
  const started = world.workerStarted(worker.actor)
  expect(started).toMatchObject({ pid: worker.process.pid, generation, instance: worker.instance })
  expect(tableIdentity(table)(worker.process.pid!), 'the worker is in the process table').not.toBeNull()
}

describe('k3: the handover predicate over the recorded executors', () => {
  const STARTED = '2026-11-16T10:00:00.000Z'
  const OLD_ACTOR = 'worker:answer:old'
  const NEW_ACTOR = 'worker:answer:new'
  const ts = (): string => new Date().toISOString()

  function bus(): DatabaseSync {
    const root = mkdtempSync(path.join(tmpdir(), 'k3-predicate-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    return db
  }

  function register(db: DatabaseSync, child: { mode: 'child' | 'inline', kind: string, taskKey: string, pid: number, tree: string | null }, generation = OLD_GENERATION): void {
    recordChildStarted(db, ts(), OLD_ACTOR, { ...child, instance: 'old', generation, pgid: child.pid, lstart: STARTED })
  }

  function ended(db: DatabaseSync, taskKey: string, pid: number): void {
    recordChildEnded(db, ts(), OLD_ACTOR, { instance: 'old', pid, taskKey, exit: 0, signal: null })
  }

  const living = (...pids: number[]) => aliveBy(pid => pids.includes(pid) ? { lstart: STARTED } : null)

  function rows(...pids: number[]): ReturnType<ReturnType<typeof livesIn>> {
    return livesIn(new InMemoryProcessTable({ rows: pids.map(pid => ({ pid, ppid: 1, pgid: pid, started: STARTED, command: 'node' })) }))()
  }

  it('a queued task whose registered executor lives is not leased, and is leased once its child.ended is recorded', () => {
    const db = bus()
    const key = taskKey({ queue: 'answer', cardId: 1 })
    queueTask(db, ts(), { queue: 'answer', cardId: 1 })
    register(db, { mode: 'child', kind: 'answer', taskKey: key, pid: 11, tree: '/trees/1' })
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'answer', NEW_ACTOR, undefined, living(11))).toBeNull()
    ended(db, key, 11)
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'answer', NEW_ACTOR, undefined, living(11))?.taskKey).toBe(key)
  })

  it('an executor whose pid is gone or runs another start holds nothing; without a reader every registered executor holds its task', () => {
    const db = bus()
    const key = taskKey({ queue: 'answer', cardId: 1 })
    queueTask(db, ts(), { queue: 'answer', cardId: 1 })
    register(db, { mode: 'child', kind: 'answer', taskKey: key, pid: 11, tree: '/trees/1' })
    expect(heldByLiveExecutors(eventsIn(db), undefined).tasks).toEqual([key])
    expect(heldByLiveExecutors(eventsIn(db), aliveBy(() => ({ lstart: '2026-11-16T11:00:00.000Z' }))).tasks).toEqual([])
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'answer', NEW_ACTOR, undefined, living())?.taskKey).toBe(key)
  })

  it('a live witness command keeps its own task, which holds no card tree, and the task is leased once its child.ended is recorded', () => {
    const db = bus()
    const key = taskKey({ queue: 'witness', cardId: 1 })
    queueTask(db, ts(), { queue: 'witness', cardId: 1 })
    register(db, { mode: 'child', kind: 'witness', taskKey: key, pid: 11, tree: '/trees/1' })
    expect(heldByLiveExecutors(eventsIn(db), living(11))).toEqual({ tasks: [key], cards: [], prs: [] })
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'witness', NEW_ACTOR, undefined, living(11))).toBeNull()
    ended(db, key, 11)
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'witness', NEW_ACTOR, undefined, living(11))?.taskKey).toBe(key)
  })

  it('a live answer session keeps the answer and launch tasks of its card, and a task of another card is leased', () => {
    const db = bus()
    const answer = taskKey({ queue: 'answer', cardId: 1 })
    queueTask(db, ts(), { queue: 'answer', cardId: 1 })
    leaseNext(db, ts(), 'answer', OLD_ACTOR)
    register(db, { mode: 'child', kind: 'answer', taskKey: answer, pid: 11, tree: '/trees/1' })
    queueTask(db, ts(), { queue: 'launch', cardId: 1, generation: 'next' })
    queueTask(db, ts(), { queue: 'launch', cardId: 2 })
    expect(heldByLiveExecutors(eventsIn(db), living(11)).cards).toEqual([1])
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'launch', NEW_ACTOR, undefined, living(11))?.cardId).toBe(2)
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'launch', NEW_ACTOR, undefined, living(11))).toBeNull()
  })

  it('a live inline executor keeps its pull request from every update, merge and close task, and another pull request is leased', () => {
    const db = bus()
    const [head, other] = ['c'.repeat(40), 'd'.repeat(40)]
    for (const [card, pr, sha] of [[1, 17, head], [2, 18, other]] as const)
      appendEvent(db, { ts: ts(), type: PR_OBSERVED, actor: 'netwatch', cardId: card, pr, head: sha, dedupeKey: `${PR_OBSERVED}:${pr}:${sha}`, payload: { card_id: card, base: 'main', head: sha, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
    reduce(db, 'pending', busProjections())
    const update = { queue: 'update', cardId: 1, pr: 17, head } as const
    queueTask(db, ts(), update)
    leaseNext(db, ts(), 'update', 'worker:update:old')
    register(db, { mode: 'inline', kind: 'update', taskKey: taskKey(update), pid: 11, tree: prTree(17) })
    queueTask(db, ts(), { queue: 'merge', cardId: 1, pr: 17, head })
    queueTask(db, ts(), { queue: 'merge', cardId: 2, pr: 18, head: other })
    expect(heldByLiveExecutors(eventsIn(db), living(11)).prs).toEqual([17])
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'merge', 'worker:merge:new', undefined, living(11))?.pr).toBe(18)
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'merge', 'worker:merge:new', undefined, living(11))).toBeNull()
  })

  it('a retiring worker releases retired_unstarted only its own leases with no child.started since they were leased', () => {
    const db = bus()
    queueTask(db, ts(), { queue: 'answer', cardId: 1 })
    queueTask(db, ts(), { queue: 'answer', cardId: 2 })
    queueTask(db, ts(), { queue: 'answer', cardId: 3 })
    const started = leaseNext(db, ts(), 'answer', OLD_ACTOR)!
    const deferred = leaseNext(db, ts(), 'answer', OLD_ACTOR)!
    leaseNext(db, ts(), 'answer', NEW_ACTOR)
    register(db, { mode: 'child', kind: 'answer', taskKey: started.taskKey, pid: 11, tree: '/trees/1' })
    expect(releaseUnstarted(db, eventsIn(db), ts(), OLD_ACTOR)).toEqual([deferred.taskKey])
    expect(new BusRead(db).slice(TASK_RELEASED, ['task_key', 'reason']).map(each => ({ actor: each.actor, ...each.fields }))).toEqual([{ actor: OLD_ACTOR, task_key: deferred.taskKey, reason: RETIRED_UNSTARTED }])
    expect(releaseUnstarted(db, eventsIn(db), ts(), OLD_ACTOR)).toEqual([])
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'answer', NEW_ACTOR, undefined, living(11))?.taskKey).toBe(deferred.taskKey)
  })

  it('the new generation takes the later task while the retiring worker holds its lease-loop pass', () => {
    const db = bus()
    queueTask(db, ts(), { queue: 'answer', cardId: 1 })
    recordWorkerIdentity(db, ts(), { worker: OLD_ACTOR, pid: 21, started: STARTED, instance: 'old', generation: OLD_GENERATION, pgid: 21, lstart: STARTED })
    const first = leaseNext(db, ts(), 'answer', OLD_ACTOR)!
    register(db, { mode: 'child', kind: 'answer', taskKey: first.taskKey, pid: 11, tree: '/trees/1' })
    const retiredMidPass = aliveBy((pid) => {
      if (retireHolders(db, ts(), { node: 'answer', pids: [21], sha: NEW_GENERATION, from: OLD_GENERATION }).length > 0)
        queueTask(db, ts(), { queue: 'answer', cardId: 2 })
      return pid === 11 ? { lstart: STARTED } : null
    })
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'answer', OLD_ACTOR, undefined, retiredMidPass)).toBeNull()
    expect(leaseHandedOver(db, eventsIn(db), ts(), 'answer', NEW_ACTOR, undefined, living(11))?.cardId).toBe(2)
  })

  it('generation.ended is recorded once, after the last process registered under the leaving generation has ended, and never for the current one', () => {
    const db = bus()
    recordWorkerIdentity(db, ts(), { worker: OLD_ACTOR, pid: 21, started: STARTED, instance: 'old', generation: OLD_GENERATION, pgid: 21, lstart: STARTED })
    recordWorkerIdentity(db, ts(), { worker: NEW_ACTOR, pid: 22, started: STARTED, instance: 'new', generation: NEW_GENERATION, pgid: 22, lstart: STARTED })
    register(db, { mode: 'child', kind: 'launch', taskKey: 'launch:1:-:-', pid: 23, tree: '/trees/1' })
    expect(generationsEnded(db, ts(), rows(22, 23))).toEqual([])
    expect(generationsEnded(db, ts(), rows(21, 22))).toEqual([])
    expect(generationsEnded(db, ts(), rows(22))).toEqual([OLD_GENERATION])
    expect(generationsEnded(db, ts(), rows())).toEqual([])
    expect(generationsEnded(db, ts(), livesIn(new InMemoryProcessTable({ rows: { unreadable: 'ps refused' } }))())).toEqual([])
    expect(new BusRead(db).slice(GENERATION_ENDED, ['generation']).map(each => each.fields)).toEqual([{ generation: OLD_GENERATION }])
  })
})

describe('k3: the helper loops of a scenario', () => {
  function loop(root: string, ticks: number): { child: ChildProcess, exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }> } {
    const child = spawn('sh', ['-c', helperLoop('exit 0', ticks), path.join(root, 'never-released')], { detached: true, stdio: 'ignore' })
    const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    return { child, exited }
  }

  function groupGone(pid: number): boolean {
    try {
      process.kill(-pid, 0)
      return false
    }
    catch {
      return true
    }
  }

  it('no helper loop outlives its scenario: a listed loop dies with its scenario, an unlisted one ends within its own bound', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'k3-handover-'))
    roots.push(root)
    const listed = loop(root, HELPER_BOUND_TICKS)
    writeFileSync(path.join(root, HELPER_PIDS), `${listed.child.pid}\n`)
    const unlisted = loop(root, 4)

    endScenario()

    expect(await listed.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(await unlisted.exited).toEqual({ code: HELPER_OUT_OF_TIME, signal: null })
    await waitWithin(() => groupGone(listed.child.pid!) && groupGone(unlisted.child.pid!), () => 'the process groups of both loops to empty', 5_000)
  }, 10_000)
})

describe('k3 [needs ps]: the handover predicate on real processes', () => {
  it('scenario 03: answer, launch and witness children of a retiring generation keep their tasks and trees until each ends on its own status', async () => {
    const world = new World()
    const [answerCard, launchCard, witnessCard] = [3101, 3102, 3103]
    const otherCard = { answer: 3104, launch: 3105, witness: 3106 }
    const keys = { answer: world.queue('answer', answerCard), launch: world.queue('launch', launchCard), witness: world.queue('witness', witnessCard) }
    const sessions = { answer: world.session(answerCard), launch: world.session(launchCard, true), witness: world.session(witnessCard, true) }
    const cardOf = { answer: answerCard, launch: launchCard, witness: witnessCard }
    const kinds = ['answer', 'launch', 'witness'] as const
    const old = Object.fromEntries(kinds.map(kind => [kind, world.start(OLD_GENERATION, { kind, session: `old-${kind}`, sessions: { [cardOf[kind]]: sessions[kind] } })])) as Record<typeof kinds[number], Worker>
    await waitFor(() => kinds.every(kind => world.childStarted(keys[kind]) !== undefined), 'a child.started for each old round')

    for (const kind of kinds)
      expect(world.retire(kind, old[kind])).toEqual([keys[kind]])
    await waitFor(() => kinds.every(kind => world.leftItsLoop(old[kind])), 'each old worker to leave its lease loop before a task of another card is queued')
    expireLeases(world.db, FAR_FUTURE, SILENT_MS)
    const otherKeys = Object.fromEntries(kinds.map(kind => [kind, world.queue(kind, otherCard[kind])])) as Record<typeof kinds[number], string>
    const fresh = Object.fromEntries(kinds.map(kind => [kind, world.start(NEW_GENERATION, { kind, session: `new-${kind}` })])) as Record<typeof kinds[number], Worker>
    await waitFor(() => kinds.every(kind => world.completedBy(otherKeys[kind]) === fresh[kind].actor), 'the new generation to pass over the held task and take the later task of another card')

    for (const kind of kinds) {
      expect(pidAlive(Number(world.childStarted(keys[kind])!.fields.pid)), `${kind} session alive`).toBe(true)
      expect(world.leasedBy(keys[kind]), `${kind}: no lease by the new generation while its executor lives`).toEqual([old[kind].actor])
      expect(heldByLiveExecutors(eventsIn(world.db), alive).tasks).toContain(keys[kind])
    }
    expect(world.endGenerations()).toEqual([])
    expect(world.generationEnded()).toEqual([])

    for (const kind of kinds)
      world.open(String(cardOf[kind]))
    await waitFor(() => kinds.every(kind => world.completedBy(keys[kind]) === fresh[kind].actor), 'the new generation to take each task once its executor ended')
    const exits = await Promise.all(kinds.map(async kind => old[kind].exited))
    expect(exits).toEqual(kinds.map(() => ({ code: 0, signal: null })))

    for (const kind of kinds) {
      const ended = world.childEnded(keys[kind])!
      expect(ended.fields).toMatchObject({ exit: 0, signal: null })
      const lease = world.read().slice(TASK_LEASED, ['task_key']).find(each => each.fields.task_key === keys[kind] && each.actor === fresh[kind].actor)!
      expect(lease.id, `${kind}: leased again only after its child.ended`).toBeGreaterThan(ended.id)
      expect(world.remoteHead(`card-${cardOf[kind]}`)).toBe(git(sessions[kind].tree, 'rev-parse', 'HEAD'))
    }
    expect(world.endGenerations()).toEqual([OLD_GENERATION])
    const [ended] = world.generationEnded()
    expect(ended!.generation).toBe(OLD_GENERATION)
    expect(ended!.id).toBeGreaterThan(Math.max(...kinds.map(kind => world.childEnded(keys[kind])!.id)))
    expect(world.signalsSent()).toBe(0)
  }, SCENARIO_MS)

  it('scenario 07: a load-gate deferral on a retiring worker is released retired_unstarted and its round runs on the new generation to a pushed commit', async () => {
    const world = new World()
    const card = 3701
    const key = world.queue('answer', card)
    const old = world.start(OLD_GENERATION, { kind: 'answer', session: 'old-answer', defer: [card] })
    await waitFor(() => world.leasedBy(key).includes(old.actor), 'the old worker to lease the deferred answer')
    const session = world.session(card)
    world.open(String(card))
    const fresh = world.start(NEW_GENERATION, { kind: 'answer', session: 'new-answer', sessions: { [card]: session } })
    await waitFor(() => world.workerStarted(fresh.actor) !== undefined, 'the new worker to record its start')

    world.retire('answer', old)
    await waitFor(() => world.completedBy(key) === fresh.actor, 'the new generation to run the deferred round')

    const [released] = world.read().slice(TASK_RELEASED, ['task_key', 'reason'])
    expect(released).toMatchObject({ actor: old.actor, fields: { task_key: key, reason: RETIRED_UNSTARTED } })
    expect(world.workerStarted(old.actor)).toMatchObject({ generation: OLD_GENERATION, instance: old.instance })
    expect(world.leasedBy(key)).toEqual([old.actor, fresh.actor])
    expectLiveIdentity(world, fresh, NEW_GENERATION)
    expect(world.childStarted(key)!.fields).toMatchObject({ mode: 'child', generation: NEW_GENERATION, instance: fresh.instance })
    expect(world.childEnded(key)!.fields).toMatchObject({ exit: 0, signal: null })
    expect(world.remoteHead(`card-${card}`)).toBe(git(session.tree, 'rev-parse', 'HEAD'))
    expect(await old.exited).toEqual({ code: 0, signal: null })
    expect(world.signalsSent()).toBe(0)
  }, SCENARIO_MS)

  it('scenario 13: the unstarted sibling is handed over at once while the started round of the same worker runs to its own end', async () => {
    const world = new World()
    const [startedCard, deferredCard] = [1301, 1302]
    const startedKey = world.queue('answer', startedCard)
    const deferredKey = world.queue('answer', deferredCard)
    const startedSession = world.session(startedCard)
    const deferredSession = world.session(deferredCard)
    world.open(String(deferredCard))
    const old = world.start(OLD_GENERATION, { kind: 'answer', session: 'old-answer', defer: [deferredCard], sessions: { [startedCard]: startedSession } })
    await waitFor(() => world.childStarted(startedKey) !== undefined && world.leasedBy(deferredKey).includes(old.actor), 'one started and one deferred lease on the old worker')
    const fresh = world.start(NEW_GENERATION, { kind: 'answer', session: 'new-answer', sessions: { [deferredCard]: deferredSession } })
    await waitFor(() => world.workerStarted(fresh.actor) !== undefined, 'the new worker to record its start')

    world.retire('answer', old)
    await waitFor(() => world.leasedBy(deferredKey).includes(fresh.actor), 'the new generation to lease the unstarted sibling')

    const sessionPid = Number(world.childStarted(startedKey)!.fields.pid)
    expect(pidAlive(sessionPid), 'the started round still runs').toBe(true)
    expect(world.childEnded(startedKey)).toBeUndefined()
    expect(world.endGenerations()).toEqual([])
    expect(world.generationEnded()).toEqual([])
    expect(world.read().slice(TASK_RELEASED, ['task_key', 'reason']).map(each => each.fields)).toEqual([{ task_key: deferredKey, reason: RETIRED_UNSTARTED }])
    expect(world.leasedBy(startedKey)).toEqual([old.actor])

    await waitFor(() => world.completedBy(deferredKey) === fresh.actor, 'the handed round to complete on the new generation')
    expect(world.remoteHead(`card-${deferredCard}`)).toBe(git(deferredSession.tree, 'rev-parse', 'HEAD'))
    world.open(String(startedCard))
    expect(await old.exited).toEqual({ code: 0, signal: null })
    expect(world.completedBy(startedKey)).toBe(old.actor)
    expect(world.childEnded(startedKey)!.fields).toMatchObject({ exit: 0, signal: null })
    expect(world.remoteHead(`card-${startedCard}`)).toBe(git(startedSession.tree, 'rev-parse', 'HEAD'))
    expect(world.endGenerations()).toEqual([OLD_GENERATION])
    expect(world.signalsSent()).toBe(0)
  }, SCENARIO_MS)

  it('scenario 17: a retiring update worker blocked in an inline update keeps the task and the PR tree, pushes once, completes it, then records child.ended', async () => {
    const world = new World()
    const [card, pr] = [1701, 17]
    const tree = world.tree(`pr-${pr}`)
    const head = git(tree, 'rev-parse', 'HEAD')
    git(tree, 'commit', '-q', '--allow-empty', '-m', 'main merged into the pull request')
    world.observe(card, pr, head)
    const key = world.queue('update', card, { pr, head })
    const standIn = ['sh', '-c', helperLoop('git -C "$1" push -q origin HEAD'), world.release('update'), tree]
    const old = world.start(OLD_GENERATION, { kind: 'update', session: 'old-update', inline: { [card]: standIn } })
    await waitFor(() => world.childStarted(key) !== undefined, 'the inline executor record of the old worker')
    const fresh = world.start(NEW_GENERATION, { kind: 'update', session: 'new-update', inline: { [card]: ['git', '-C', tree, 'push', '-q', 'origin', 'HEAD'] } })
    await waitFor(() => world.workerStarted(fresh.actor) !== undefined, 'the new update worker to record its start')
    expect(world.retire('update', old)).toEqual([key])

    expect(world.childStarted(key)!.fields).toMatchObject({ mode: 'inline', kind: 'update', task_key: key, tree: `pr:${pr}`, pid: old.process.pid, generation: OLD_GENERATION, instance: old.instance })
    const held = heldByLiveExecutors(eventsIn(world.db), alive)
    expect(held.tasks).toContain(key)
    expect(held.prs).toContain(pr)
    expect(world.leasedBy(key)).toEqual([old.actor])
    expect(pidAlive(old.process.pid!)).toBe(true)
    expect(world.pushes()).toEqual([])

    world.open('update')
    expect(await old.exited).toEqual({ code: 0, signal: null })

    expect(world.pushes()).toEqual([`refs/heads/pr-${pr} ${git(tree, 'rev-parse', 'HEAD')}`])
    expect(world.completedBy(key)).toBe(old.actor)
    const completed = world.read().slice(TASK_COMPLETED, ['task_key']).find(each => each.fields.task_key === key)!
    const ended = world.childEnded(key)!
    expect(ended.fields).toMatchObject({ exit: 0, signal: null, pid: old.process.pid })
    expect(ended.id).toBeGreaterThan(completed.id)
    expect(world.leasedBy(key)).toEqual([old.actor])
    expect(heldByLiveExecutors(eventsIn(world.db), alive).tasks).not.toContain(key)
    expect(world.signalsSent()).toBe(0)
  }, SCENARIO_MS)
})
