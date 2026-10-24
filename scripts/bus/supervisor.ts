import type { DatabaseSync } from 'node:sqlite'
import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from './bg.js'
import type { InForceDecision } from './decisions.js'
import type { ProcessBeat } from './heartbeat.js'
import type { HolderProcess, HolderReading, ProcessStartOf } from './lease.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { busDirOf, pinBus } from '../core/bus-path.js'
import { PROCESS_JUDGED, RESTARTED, TASK_EXPIRED, WORKER_DOWN } from '../core/events.js'
import { launchName, PREFIX, printBg, psList, runBusBg, runningInstance, startDetached } from './bg.js'
import { RUNNING_CARD } from './card-automaton.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { inForceDecisions } from './decisions.js'
import { CARD_PROCESS, lastProcessBeats, recordProcessHeartbeat } from './heartbeat.js'
import { RESTART_MISSED } from './inbox.js'
import { closeDrain, expireLeasesHeldBy, HOLDER_DEAD, HOLDER_UNPROVEN, judgeHolders, LEASE_MS, leasesHeldBy, openDrain, WORKER_HUNG } from './lease.js'
import { allowLiveCommand, liveDecisionOf } from './live-decision.js'
import { beatsLive, SILENT_MS } from './liveness-sites.js'
import { CHECK_MS } from './netwatch.js'
import { LIVE_FLAG } from './node.js'
import { busShadowProblems, startReviewWorker } from './review-bg.js'
import { stampLogOutput } from './stamp.js'
import { busLaunches, isBusWorker, switchDetection, switchWorker, wantedLaunches, WORKERS } from './workers.js'

export const SUPERVISE_FLAG = '--supervise'
export const ON_FLAG = '--on'
export const OFF_FLAG = '--off'
export const LIVE_ON_FLAG = '--live'
export const LIVE_OFF_FLAG = '--shadow'
export const STOP_WAIT_MS = 10_000
export const STOP_POLL_MS = 100
export const RESTART_LIMIT_MS = 5 * 60_000
export const DRAIN_LIMIT_MS = LEASE_MS
export const GIT_PULL_TIMEOUT_MS = 60_000

export const SUPERVISOR_INSTANCE_FILE = 'bus-bg.pid'

export const SUPERVISOR_LAUNCH: DetachedLaunch = {
  prefix: PREFIX,
  script: 'bus:bg',
  args: [SUPERVISE_FLAG],
  markers: [`scripts/bus/supervisor.ts ${SUPERVISE_FLAG}`, `--silent bus:bg ${SUPERVISE_FLAG}`],
  instanceFile: SUPERVISOR_INSTANCE_FILE,
  startLock: 'bus-bg-supervise.lock',
  log: 'supervisor.log',
}

export interface MainAdvance {
  id: number
  sha: string
}

export function lastMainAdvance(db: DatabaseSync): number {
  return Number((db.prepare(`SELECT coalesce(max(id), 0) AS id FROM events WHERE type = 'main.advanced'`).get() as { id: number }).id)
}

export function mainAdvancedSince(db: DatabaseSync, afterId: number): MainAdvance[] {
  return db.prepare(`SELECT id, payload FROM events WHERE type = 'main.advanced' AND id > ? ORDER BY id`).all(afterId).flatMap((row) => {
    const sha = (JSON.parse(String(row.payload)) as { sha?: unknown }).sha
    return typeof sha === 'string' ? [{ id: Number(row.id), sha }] : []
  })
}

export interface BusCode {
  head: () => string
  holds: (sha: string) => boolean
  pull: () => void
  changedSince: (sha: string) => string[]
  runs: (entry: string) => ReadonlySet<string>
  localMain?: () => string | null
}

export const LOCAL_MAIN_REF = 'refs/heads/main'

export const SHARED_BUS_CODE: readonly string[] = ['scripts/bus/db.ts', 'scripts/bus/node.ts', 'scripts/bus/lease.ts', 'scripts/bus/queue.ts', 'scripts/bus/reducer.ts']

const RELATIVE_IMPORT = /\b(?:import|export)\s[^'"]*?\sfrom\s*'(\.{1,2}\/[^']+)'|\bimport\s*'(\.{1,2}\/[^']+)'/g

export function importClosure(entry: string, readFile: (file: string) => string | null): Set<string> {
  const texts = new Map<string, string | null>()
  const read = (file: string): string | null => {
    if (!texts.has(file))
      texts.set(file, readFile(file))
    return texts.get(file) ?? null
  }
  const sourceOf = (target: string): string => target.endsWith('.js') && read(`${target.slice(0, -3)}.ts`) !== null ? `${target.slice(0, -3)}.ts` : target
  const seen = new Set<string>()
  const next = [entry]
  for (let file = next.pop(); file !== undefined; file = next.pop()) {
    if (seen.has(file))
      continue
    const text = read(file)
    if (text === null)
      continue
    seen.add(file)
    for (const match of text.matchAll(RELATIVE_IMPORT))
      next.push(sourceOf(path.posix.join(path.posix.dirname(file), match[1] ?? match[2]!)))
  }
  return seen
}

export function entryOf(launch: DetachedLaunch): string | null {
  return launch.markers.find(marker => marker.startsWith('scripts/'))?.split(' ')[0] ?? null
}

function readable(cwd: string): (file: string) => string | null {
  return (file) => {
    try {
      return readFileSync(path.join(cwd, file), 'utf8')
    }
    catch {
      return null
    }
  }
}

export function gitCode(cwd: string): BusCode {
  const git = (args: string[]): number => spawnSync('git', args, { cwd, stdio: 'ignore' }).status ?? -1
  return {
    head: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    localMain: () => {
      const read = spawnSync('git', ['rev-parse', '--verify', '--quiet', LOCAL_MAIN_REF], { cwd, encoding: 'utf8' })
      return read.status === 0 ? read.stdout.trim() : null
    },
    holds: sha => git(['merge-base', '--is-ancestor', sha, 'HEAD']) === 0,
    pull: () => {
      execFileSync('git', ['pull', '--ff-only', '--quiet'], { cwd, stdio: 'pipe', timeout: GIT_PULL_TIMEOUT_MS, killSignal: 'SIGKILL' })
    },
    changedSince: sha => execFileSync('git', ['diff', '--name-only', sha, 'HEAD'], { cwd, encoding: 'utf8' }).split('\n').filter(file => file !== ''),
    runs: entry => new Set([...importClosure(entry, readable(cwd)), ...SHARED_BUS_CODE]),
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name)
  }
  catch {
    try {
      process.kill(pid, name)
    }
    catch {}
  }
}

export async function stopInstance(running: RunningProcess, markers: readonly string[], processes: ProcessList, pause: (ms: number) => Promise<unknown> = sleep): Promise<void> {
  signal(running.pid, 'SIGTERM')
  for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
    if (runningInstance(processes(), markers) === undefined)
      return
    await pause(STOP_POLL_MS)
  }
  for (const left of processes().filter(candidate => candidate.pid !== process.pid && markers.some(marker => candidate.args.includes(marker))))
    signal(left.pid, 'SIGKILL')
  await pause(STOP_POLL_MS)
}

export interface SupervisorParts {
  known: DetachedLaunch[]
  wanted: () => DetachedLaunch[]
  start: (launch: DetachedLaunch) => BgResult
  stop: (running: RunningProcess, launch: DetachedLaunch) => Promise<void>
  freeLeases?: (stopped: DetachedLaunch[]) => string[]
  drain?: Drain
  processes: ProcessList
  mainSince: (afterId: number) => MainAdvance[]
  code: BusCode
  journal: (entry: Record<string, unknown>) => void
  missed?: (sha: string, waitedMs: number) => void
  now: () => number
}

export interface Drain {
  held: (running: DetachedLaunch[]) => string[]
  open: (sha: string, untilMs: number, draining: DetachedLaunch[]) => void
  close: (sha: string, drained: DetachedLaunch[]) => void
}

interface Restarted {
  lines: string[]
  down: string[]
}

interface RestartScope {
  launches: DetachedLaunch[]
  self: boolean
  every: boolean
}

interface Drained {
  waits: boolean
  lines: string[]
}

function namesOf(scope: RestartScope): string[] {
  return [...scope.launches.map(launch => launch.script), ...scope.self ? [SUPERVISOR_LAUNCH.script] : []]
}

function startedOrTechnical(start: (launch: DetachedLaunch) => BgResult, launch: DetachedLaunch): BgResult {
  try {
    return start(launch)
  }
  catch (error) {
    return { stdout: [], stderr: [`${PREFIX}${launchName(launch)} did not start, a technical failure: ${error instanceof Error ? error.message : String(error)}`], exitCode: 1 }
  }
}

export class BusSupervisor {
  private codeSha: string
  private pending: string | null = null
  private outdatedBy: string | null = null
  private waiting: { sha: string, since: number, reported: boolean } | null = null
  private draining: { sha: string, since: number } | null = null
  private opened: DetachedLaunch[] = []
  private localMain: string | null

  constructor(private readonly parts: SupervisorParts, private seen: number) {
    this.codeSha = parts.code.head()
    this.localMain = parts.code.localMain?.() ?? null
  }

  get ownCodeBehind(): string | null {
    return this.outdatedBy
  }

  async step(): Promise<string[]> {
    try {
      const advanced = await this.advance()
      return [...advanced, ...await this.stopSwitchedOff(), ...await this.moveModes(), ...this.watchLimit()]
    }
    catch (error) {
      const waiting = this.pending === null ? '' : `; main.advanced to ${this.pending} stays pending and is retried on the next tick`
      return [`${PREFIX}supervisor step failed: ${error instanceof Error ? error.message : String(error)}${waiting}`, ...this.watchLimit()]
    }
  }

  private watchLimit(): string[] {
    const sha = this.pending ?? this.outdatedBy
    if (sha === null || this.drainWaits()) {
      this.waiting = null
      return []
    }
    if (this.waiting?.sha !== sha)
      this.waiting = { sha, since: this.parts.now(), reported: false }
    const waitedMs = this.parts.now() - this.waiting.since
    if (this.waiting.reported || waitedMs < RESTART_LIMIT_MS)
      return []
    try {
      this.parts.missed?.(sha, waitedMs)
    }
    catch (error) {
      return [`${PREFIX}recording ${RESTART_MISSED} failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
    this.waiting.reported = true
    return [`${PREFIX}the restart onto ${sha} did not happen within ${RESTART_LIMIT_MS / 60_000} min (waited ${Math.round(waitedMs / 1000)}s); ${RESTART_MISSED} is on the bus and the board`]
  }

  private drainWaits(): boolean {
    return this.draining !== null && this.parts.now() - this.draining.since < DRAIN_LIMIT_MS
  }

  private async stopSwitchedOff(): Promise<string[]> {
    const processes = this.parts.processes()
    const wanted = new Set(this.parts.wanted().map(launch => launch.script))
    const off = this.parts.known.flatMap((launch) => {
      const instance = wanted.has(launch.script) ? undefined : runningInstance(processes, launch.markers)
      return instance === undefined ? [] : [{ launch, instance }]
    })
    const lines: string[] = []
    for (const { launch, instance } of off) {
      await this.parts.stop(instance, launch)
      lines.push(`${PREFIX}${launchName(launch)} is switched off and was running as pid ${instance.pid}; stopped it`)
    }
    return off.length === 0 ? lines : [...lines, ...this.parts.freeLeases?.(off.map(({ launch }) => launch)) ?? []]
  }

  private async moveModes(): Promise<string[]> {
    const processes = this.parts.processes()
    const diverged = this.parts.wanted().flatMap((launch) => {
      const instance = runningInstance(processes, launch.markers)
      return instance !== undefined && instance.args.includes(LIVE_FLAG) !== launch.args.includes(LIVE_FLAG) ? [{ launch, instance }] : []
    })
    const lines: string[] = []
    for (const { launch, instance } of diverged) {
      await this.parts.stop(instance, launch)
      lines.push(`${PREFIX}${launchName(launch)} runs in the other mode than workers.json lists; restarting it ${launch.args.includes(LIVE_FLAG) ? 'live' : 'in shadow'}`)
      lines.push(...this.parts.freeLeases?.([launch]) ?? [])
      const started = startedOrTechnical(this.parts.start, launch)
      lines.push(...started.stdout, ...started.stderr)
    }
    return lines
  }

  private async advance(): Promise<string[]> {
    const advanced = this.parts.mainSince(this.seen)
    const movedTo = this.localMainMove()
    const lines: string[] = []
    if (advanced.length > 0) {
      this.seen = advanced.at(-1)!.id
      this.pending = advanced.at(-1)!.sha
    }
    else if (movedTo !== null) {
      this.pending = movedTo
      lines.push(`${PREFIX}the local ${LOCAL_MAIN_REF} moved to ${movedTo} with no main.advanced on the bus; the restart follows it`)
    }
    if (this.pending === null)
      return lines
    if (!this.parts.code.holds(this.pending)) {
      const failure = this.pullFailure()
      if (!this.parts.code.holds(this.pending)) {
        if (advanced.length > 0)
          lines.push(`${PREFIX}main advanced to ${this.pending}; the checkout does not hold it yet${failure === null ? '' : ` (git pull --ff-only failed: ${failure})`}, the restart waits for it`)
        return lines
      }
    }
    const sha = this.pending
    const scope = this.scopeOf(this.parts.code.changedSince(this.codeSha))
    const head = this.parts.code.head()
    if (!scope.self && scope.launches.length === 0) {
      this.settle(head)
      return [...lines, `${PREFIX}main advanced to ${sha} with no change to the code a bus process runs; nothing restarted`]
    }
    const drained = this.drain(head, scope)
    if (drained.waits)
      return [...lines, ...drained.lines]
    const restarted = await this.restart(scope, head)
    this.draining = null
    this.settle(head)
    if (scope.self)
      this.outdatedBy = head
    const notBack = restarted.down.length === 0 ? '' : `; not brought back: ${restarted.down.join(', ')}`
    const restarting = scope.every
      ? `a change to the code every bus process runs; restarting every running bus process on ${head}`
      : `a change to the code of ${namesOf(scope).join(', ')}; restarting only those on ${head}, and every other bus process runs on`
    return [...lines, ...drained.lines, `${PREFIX}main advanced to ${sha} with ${restarting}${notBack}`, ...restarted.lines]
  }

  private scopeOf(changed: readonly string[]): RestartScope {
    const runsChanged = (launch: DetachedLaunch): boolean => {
      const entry = entryOf(launch)
      if (entry === null)
        return changed.length > 0
      const runs = this.parts.code.runs(entry)
      return changed.some(file => runs.has(file))
    }
    const launches = this.parts.known.filter(runsChanged)
    const self = runsChanged(SUPERVISOR_LAUNCH)
    return { launches, self, every: self && launches.length === this.parts.known.length }
  }

  private localMainMove(): string | null {
    const now = this.parts.code.localMain?.() ?? null
    if (now === null || now === this.localMain)
      return null
    this.localMain = now
    return now
  }

  private drain(head: string, scope: RestartScope): Drained {
    const drain = this.parts.drain
    if (drain === undefined)
      return { waits: false, lines: [] }
    const processes = this.parts.processes()
    const held = drain.held(scope.launches.filter(launch => runningInstance(processes, launch.markers) !== undefined))
    const draining = this.draining
    if (held.length === 0) {
      this.draining = null
      return { waits: false, lines: [] }
    }
    const now = this.parts.now()
    if (draining?.sha !== head) {
      const since = draining?.since ?? now
      drain.open(head, since + DRAIN_LIMIT_MS, scope.launches)
      this.opened = [...new Set([...this.opened, ...scope.launches])]
      this.draining = { sha: head, since }
      const takers = scope.every ? 'no worker takes a new one' : `${namesOf(scope).join(', ')} take no new one`
      if (now - since < DRAIN_LIMIT_MS)
        return { waits: true, lines: [`${PREFIX}the restart onto ${head} waits for the leases in flight to finish, and ${takers}: ${held.join(', ')}`] }
    }
    else if (now - draining.since < DRAIN_LIMIT_MS) {
      return { waits: true, lines: [] }
    }
    return { waits: false, lines: [`${PREFIX}the leases in flight did not finish within ${DRAIN_LIMIT_MS / 60_000} min; restarting on ${head} anyway, and these are freed as ${TASK_EXPIRED}: ${held.join(', ')}`] }
  }

  private pullFailure(): string | null {
    try {
      this.parts.code.pull()
      return null
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private settle(head: string): void {
    this.pending = null
    this.codeSha = head
  }

  private async restart(scope: RestartScope, head: string): Promise<Restarted> {
    const scripts = new Set(scope.launches.map(launch => launch.script))
    const wanted = this.parts.wanted().filter(launch => scripts.has(launch.script))
    const processes = this.parts.processes()
    const running = scope.launches.flatMap((launch) => {
      const instance = runningInstance(processes, launch.markers)
      return instance === undefined ? [] : [{ launch, instance }]
    })
    for (const { launch, instance } of running)
      await this.parts.stop(instance, launch)
    const stopped = running.map(({ launch }) => launch)
    const freed = this.parts.freeLeases?.(stopped) ?? []
    if (!scope.self && this.opened.length > 0)
      this.parts.drain?.close(head, this.opened)
    this.opened = []
    const down: string[] = []
    const lines = wanted.flatMap((launch) => {
      const name = launchName(launch)
      const started = startedOrTechnical(this.parts.start, launch)
      if (started.exitCode !== 0 && started.alreadyRunning === undefined) {
        down.push(name)
        this.parts.journal({ ts: new Date(this.parts.now()).toISOString(), event: 'worker.down', worker: name, failures: [causeOf(started)], restart: head })
      }
      return [...started.stdout, ...started.stderr]
    })
    return { lines: [...freed, ...lines], down }
  }
}

export function recordRestartMissed(db: DatabaseSync, ts: string, sha: string, waitedMs: number): void {
  appendEvent(db, { ts, type: RESTART_MISSED, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${RESTART_MISSED}:${sha}`, payload: { sha, waited_ms: waitedMs, limit_ms: RESTART_LIMIT_MS }, legacy: false })
}

export function recordRestarted(db: DatabaseSync, ts: string, sha: string): void {
  appendEvent(db, { ts, type: RESTARTED, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${RESTARTED}:${sha}`, payload: { sha }, legacy: false })
}

export function recordStarted(db: DatabaseSync, ts: string, code: BusCode, log: (line: string) => void): void {
  try {
    recordRestarted(db, ts, code.head())
  }
  catch (error) {
    log(`${PREFIX}recording ${RESTARTED} failed: ${error instanceof Error ? error.message : String(error)}; the supervisor starts without it`)
  }
}

export function baselineAdvance(last: MainAdvance | undefined, code: BusCode): number {
  if (last === undefined)
    return 0
  return code.holds(last.sha) ? last.id : last.id - 1
}

export function startingBaseline(db: DatabaseSync, code: BusCode): number {
  const lastId = lastMainAdvance(db)
  const readable = mainAdvancedSince(db, lastId - 1).at(-1)
  return readable === undefined ? lastId : baselineAdvance(readable, code)
}

function workerKindsOf(launches: DetachedLaunch[]): string[] {
  return launches.map(launch => launch.script.replace(/^bus:/, '')).filter(isBusWorker)
}

export function lstartToIso(line: string): string | null {
  const ms = Date.parse(line.trim())
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function signalledAsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function psStartOf(pid: number): HolderProcess {
  if (signalledAsGone(pid))
    return { state: 'gone' }
  const read = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (read.error !== undefined || read.status !== 0)
    return { state: 'unreadable' }
  const started = lstartToIso(read.stdout)
  return started === null ? { state: 'unreadable' } : { state: 'running', started }
}

export function holderLines(reading: HolderReading): string[] {
  return [
    ...reading.freed.length === 0 ? [] : [`${PREFIX}the holder process of these leases is gone or its pid now runs another process; freed as ${TASK_EXPIRED} (${HOLDER_DEAD}) and queued again: ${reading.freed.join(', ')}`],
    ...reading.hung.length === 0 ? [] : [`${PREFIX}the holder of these leases is running and has stopped renewing them; the leases stay, ${WORKER_HUNG} is on the board: ${reading.hung.join(', ')}`],
    ...reading.unproven.length === 0 ? [] : [`${PREFIX}the holder of these leases has no readable worker.started record, so whether it is alive cannot be proven; the leases stay, ${HOLDER_UNPROVEN} is on the board: ${reading.unproven.join(', ')}`],
  ]
}

export function busDrain(db: DatabaseSync, ts: () => string, startOf?: ProcessStartOf): Drain {
  return {
    held: (running) => {
      if (startOf !== undefined)
        judgeHolders(db, ts(), startOf)
      return leasesHeldBy(db, workerKindsOf(running))
    },
    open: (sha, untilMs, draining) => {
      const at = ts()
      for (const node of workerKindsOf(draining))
        openDrain(db, at, sha, new Date(untilMs).toISOString(), node)
    },
    close: (sha, drained) => {
      const at = ts()
      for (const node of workerKindsOf(drained))
        closeDrain(db, at, sha, node)
    },
  }
}

export function freeLeasesOf(db: DatabaseSync, ts: string, stopped: DetachedLaunch[]): string[] {
  const freed = expireLeasesHeldBy(db, ts, workerKindsOf(stopped))
  return freed.length === 0 ? [] : [`${PREFIX}freed the leases of the stopped workers at once as ${TASK_EXPIRED}: ${freed.join(', ')}`]
}

export const KEEP_BASE_MS = CHECK_MS
export const KEEP_MAX_MS = 10 * 60_000
export const FAILURES_REPORTED = 3
export const SUPERVISOR_JOURNAL = 'supervisor.jsonl'
export const REDUCE_SCRIPT = 'bus:reduce'

export interface WorkerDown {
  worker: string
  failures: number
  cause: string
  nextAttemptAt: number
}

export function recordWorkerDown(db: DatabaseSync, ts: string, down: WorkerDown): void {
  appendEvent(db, { ts, type: WORKER_DOWN, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${WORKER_DOWN}:${down.worker}:${ts}`, payload: { worker: down.worker, failures: down.failures, cause: down.cause, next_attempt_at: new Date(down.nextAttemptAt).toISOString() }, legacy: false })
}

export interface KeeperParts {
  wanted: () => DetachedLaunch[]
  start: (launch: DetachedLaunch) => BgResult
  processes: ProcessList
  reduce: () => string[]
  journal: (entry: Record<string, unknown>) => void
  down?: (down: WorkerDown) => void
  now: () => number
}

interface Streak {
  causes: string[]
  retryAt: number
  awaitingSight: boolean
  refused: boolean
}

const EXITED_AFTER_START = 'exited after start'

export function backoffMs(failures: number): number {
  return Math.min(KEEP_BASE_MS * 2 ** (failures - 1), KEEP_MAX_MS)
}

function refusedByPreflight(launch: DetachedLaunch, started: BgResult): boolean {
  return launch.preflight !== undefined && started.stderr[0] === `${launch.prefix}refused to start ${launch.script}:`
}

function causeOf(started: BgResult): string {
  return started.stderr.map(line => line.trim()).join(' ') || `exit ${started.exitCode} with nothing on stderr`
}

export class WorkerKeeper {
  private readonly streaks = new Map<string, Streak>()

  constructor(private readonly parts: KeeperParts) {}

  step(): string[] {
    try {
      const processes = this.parts.processes()
      const wanted = this.parts.wanted()
      const wantedNames = new Set(wanted.map(launchName))
      for (const name of this.streaks.keys()) {
        if (!wantedNames.has(name))
          this.streaks.delete(name)
      }
      return wanted.flatMap((launch) => {
        if (runningInstance(processes, launch.markers) === undefined)
          return this.revive(launch)
        this.seenRunning(launchName(launch))
        return []
      })
    }
    catch (error) {
      return [`${PREFIX}keeping the workers alive failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }

  private seenRunning(name: string): void {
    const streak = this.streaks.get(name)
    if (streak?.refused === true && streak.awaitingSight)
      this.streaks.set(name, { ...streak, retryAt: this.parts.now(), awaitingSight: false })
    else
      this.streaks.delete(name)
  }

  private revive(launch: DetachedLaunch): string[] {
    const name = launchName(launch)
    const streak = this.streaks.get(name)
    if (streak?.awaitingSight === true)
      return this.failed(name, streak, EXITED_AFTER_START, streak.refused)
    if (streak !== undefined && this.parts.now() < streak.retryAt)
      return []
    const lines = [`${PREFIX}${name} is switched on and not running; starting it`]
    let started = startedOrTechnical(this.parts.start, launch)
    const refusal = started.exitCode !== 0 && refusedByPreflight(launch, started) ? causeOf(started) : null
    if (refusal !== null) {
      lines.push(...started.stderr, `${PREFIX}${name} was refused by the projection preflight; running ${REDUCE_SCRIPT} once and starting it again`, ...this.parts.reduce())
      started = startedOrTechnical(this.parts.start, launch)
    }
    lines.push(...started.stdout, ...started.stderr)
    const up = started.exitCode === 0 || started.alreadyRunning !== undefined
    if (!up)
      return [...lines, ...this.failed(name, streak, causeOf(started), refusal !== null)]
    if (refusal !== null)
      return [...lines, ...this.counted(name, { causes: [...streak?.causes ?? [], refusal], retryAt: this.parts.now(), awaitingSight: true, refused: true })]
    if (started.alreadyRunning !== undefined)
      this.streaks.delete(name)
    else
      this.streaks.set(name, { causes: streak?.causes ?? [], retryAt: this.parts.now(), awaitingSight: true, refused: false })
    return lines
  }

  private failed(name: string, streak: Streak | undefined, cause: string, refused: boolean): string[] {
    const causes = [...streak?.causes ?? [], cause]
    const wait = backoffMs(causes.length)
    const retryAt = this.parts.now() + wait
    return [
      `${PREFIX}${name} failed to start ${causes.length} time(s) in a row; the next attempt in ${Math.round(wait / 1000)}s`,
      ...this.counted(name, { causes, retryAt, awaitingSight: false, refused }),
      ...causes.length > 1 ? this.downPastBackoff({ worker: name, failures: causes.length, cause, nextAttemptAt: retryAt }) : [],
    ]
  }

  private downPastBackoff(down: WorkerDown): string[] {
    try {
      this.parts.down?.(down)
      return []
    }
    catch (error) {
      return [`${PREFIX}recording ${WORKER_DOWN} for ${down.worker} failed: ${error instanceof Error ? error.message : String(error)}; written again on its next failed attempt`]
    }
  }

  private counted(name: string, streak: Streak): string[] {
    this.streaks.set(name, streak)
    const { causes } = streak
    if (causes.length !== FAILURES_REPORTED)
      return []
    this.parts.journal({ ts: new Date(this.parts.now()).toISOString(), event: 'worker.down', worker: name, failures: causes.slice(-FAILURES_REPORTED) })
    return [`${PREFIX}${name} failed ${FAILURES_REPORTED} starts in a row and needs the owner: ${causes.slice(-FAILURES_REPORTED).map((failure, index) => `${index + 1}) ${failure}`).join('; ')}; the supervisor keeps backing off and retrying`]
  }
}

export const SUPERVISOR_PROCESS = 'supervisor'
export const JUDGE_ACTOR = 'worker:supervisor:judge'
export const SUPERVISOR_BEAT_MS = 30_000
export const SUPERVISOR_SILENT_MS = 2 * 60_000
export const JUDGED_HORIZON_MS = 24 * 60 * 60_000

export interface Judgement {
  process: string
  lastBeat: string
  silentMs: number
}

export type ExpectedRunning = (name: string) => boolean

const RUNNING_CARDS = `SELECT card_id FROM cards WHERE state = '${RUNNING_CARD}'`

export function processName(launch: DetachedLaunch): string {
  return launch.script
}

export function expectedRunning(db: DatabaseSync, wanted: readonly DetachedLaunch[]): ExpectedRunning {
  const names = new Set([SUPERVISOR_PROCESS, ...wanted.map(processName), ...(db.prepare(RUNNING_CARDS).all() as { card_id: number }[]).map(row => `${CARD_PROCESS}${row.card_id}`)])
  return name => names.has(name)
}

export function judgeSilent(beats: readonly ProcessBeat[], nowMs: number, expected: ExpectedRunning): Judgement[] {
  return beats.filter(beat => expected(beat.process) && !beatsLive(beat.ts, nowMs) && nowMs - Date.parse(beat.ts) <= JUDGED_HORIZON_MS).map(beat => ({ process: beat.process, lastBeat: beat.ts, silentMs: nowMs - Date.parse(beat.ts) }))
}

export function recordJudged(db: DatabaseSync, ts: string, judgement: Judgement, limitMs = SILENT_MS): boolean {
  return appendEvent(db, { ts, type: PROCESS_JUDGED, actor: JUDGE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${PROCESS_JUDGED}:${judgement.process}:${judgement.lastBeat}`, payload: { process: judgement.process, verdict: 'silent', last_beat: judgement.lastBeat, silent_ms: judgement.silentMs, limit_ms: limitMs }, legacy: false })
}

export interface Judged {
  process: string
  lastBeat: string
}

const LAST_JUDGED = `
  SELECT json_extract(payload, '$.process') AS name, max(json_extract(payload, '$.last_beat')) AS last_beat FROM events
  WHERE type = '${PROCESS_JUDGED}' AND legacy = 0 AND json_valid(payload) AND json_extract(payload, '$.process') IS NOT NULL
  GROUP BY name ORDER BY name
`

export function stillSilent(db: DatabaseSync): Judged[] {
  const beats = new Map(lastProcessBeats(db).map(beat => [beat.process, beat.ts]))
  return (db.prepare(LAST_JUDGED).all() as { name: string, last_beat: string }[])
    .filter(row => (beats.get(row.name) ?? row.last_beat) <= row.last_beat)
    .map(row => ({ process: row.name, lastBeat: row.last_beat }))
}

export const RESTART_RETRY_MS = 5 * 60_000

export class LivenessJudge {
  private lastBeat = Number.NEGATIVE_INFINITY
  private readonly restartedAt = new Map<string, number>()

  constructor(private readonly db: DatabaseSync, private readonly now: () => number, private readonly expected: () => ExpectedRunning, private readonly restart: (process: string) => Promise<string[]> = async () => [], private readonly startOf?: ProcessStartOf) {}

  async step(): Promise<string[]> {
    try {
      const nowMs = this.now()
      const ts = new Date(nowMs).toISOString()
      if (nowMs - this.lastBeat >= SUPERVISOR_BEAT_MS) {
        recordProcessHeartbeat(this.db, ts, SUPERVISOR_PROCESS)
        this.lastBeat = nowMs
      }
      const lines: string[] = []
      const silent = judgeSilent(lastProcessBeats(this.db), nowMs, this.expected())
      for (const name of this.restartedAt.keys()) {
        if (!silent.some(judgement => judgement.process === name))
          this.restartedAt.delete(name)
      }
      for (const judgement of silent) {
        if (recordJudged(this.db, ts, judgement))
          lines.push(`${PREFIX}${judgement.process} has not beaten for ${Math.round(judgement.silentMs / 60_000)} min (limit ${SILENT_MS / 60_000} min); judged silent as ${PROCESS_JUDGED}`)
        lines.push(...await this.restartDue(judgement.process, nowMs))
      }
      if (this.startOf !== undefined)
        lines.push(...holderLines(judgeHolders(this.db, ts, this.startOf)))
      return lines
    }
    catch (error) {
      return [`${PREFIX}judging the heartbeats failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }

  private async restartDue(name: string, nowMs: number): Promise<string[]> {
    const last = this.restartedAt.get(name)
    if (last !== undefined && nowMs - last < RESTART_RETRY_MS)
      return []
    this.restartedAt.set(name, nowMs)
    try {
      return await this.restart(name)
    }
    catch (error) {
      return [`${PREFIX}restarting ${name} failed: ${error instanceof Error ? error.message : String(error)}; retried in ${RESTART_RETRY_MS / 60_000} min while it stays silent`]
    }
  }
}

export async function restartSilent(name: string, wanted: readonly DetachedLaunch[], control: SwitchControl): Promise<string[]> {
  const launch = wanted.find(each => processName(each) === name)
  if (launch === undefined)
    return []
  const running = runningInstance(control.processes(), launch.markers)
  if (running !== undefined)
    await control.stop(running, launch)
  const started = control.start(launch)
  return [`${PREFIX}${name} was judged silent; restarting it`, ...started.stdout, ...started.stderr]
}

export interface SupervisorWatch {
  db: DatabaseSync
  now: () => number
  startedAt: () => number | null
  processes: ProcessList
  stop: (running: RunningProcess) => Promise<void>
}

export async function restartSilentSupervisor(watch: SupervisorWatch): Promise<string[]> {
  const running = runningInstance(watch.processes(), SUPERVISOR_LAUNCH.markers)
  if (running === undefined)
    return []
  const beat = lastProcessBeats(watch.db).find(each => each.process === SUPERVISOR_PROCESS)?.ts
  const since = Math.max(beat === undefined ? Number.NEGATIVE_INFINITY : Date.parse(beat), watch.startedAt() ?? Number.NEGATIVE_INFINITY)
  const nowMs = watch.now()
  if (!Number.isFinite(since) || nowMs - since <= SUPERVISOR_SILENT_MS)
    return []
  const lastBeat = beat ?? new Date(since).toISOString()
  recordJudged(watch.db, new Date(nowMs).toISOString(), { process: SUPERVISOR_PROCESS, lastBeat, silentMs: nowMs - since }, SUPERVISOR_SILENT_MS)
  await watch.stop(running)
  return [`${PREFIX}the supervisor (pid ${running.pid}) has not beaten for ${Math.round((nowMs - since) / 1000)}s (limit ${SUPERVISOR_SILENT_MS / 1000}s); judged silent as ${PROCESS_JUDGED}, stopped it, and a fresh one starts`]
}

function startedAtOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return null
  }
}

async function restartSilentSupervisorOnBus(busDir: string, processes: ProcessList): Promise<string[]> {
  const db = openBus(defaultBusPath())
  try {
    return await restartSilentSupervisor({ db, now: () => Date.now(), startedAt: () => startedAtOf(path.join(busDir, SUPERVISOR_INSTANCE_FILE)), processes, stop: running => stopInstance(running, SUPERVISOR_LAUNCH.markers, processes) })
  }
  catch (error) {
    return [`${PREFIX}judging the supervisor heartbeat failed: ${error instanceof Error ? error.message : String(error)}; judged again on the next start`]
  }
  finally {
    db.close()
  }
}

export interface SupervisingParts {
  supervisor: BusSupervisor
  keeper: WorkerKeeper
  judge?: LivenessJudge
  relaunch: () => BgResult
  print: (line: string) => void
  pause: () => Promise<unknown>
}

function replacedBy(head: string, started: BgResult): { lines: string[], replaced: boolean } {
  if (started.exitCode === 0)
    return { replaced: true, lines: [...started.stdout, ...started.stderr, `${PREFIX}the supervisor ran the code it started with; a fresh supervisor runs on ${head} and this one exits`] }
  return { replaced: false, lines: [...started.stdout, ...started.stderr, `${PREFIX}the supervisor could not start a fresh supervisor on ${head}; it keeps running the code it started with and retries on the next tick`] }
}

export async function superviseUntilReplaced(parts: SupervisingParts): Promise<void> {
  for (;;) {
    const lines = await parts.supervisor.step()
    const head = parts.supervisor.ownCodeBehind
    const replacement = head === null ? { lines: [], replaced: false } : replacedBy(head, parts.relaunch())
    for (const line of [...lines, ...replacement.lines, ...replacement.replaced ? [] : [...parts.keeper.step(), ...await parts.judge?.step() ?? []]])
      parts.print(line)
    if (replacement.replaced)
      return
    await parts.pause()
  }
}

export interface GroupedProcess extends RunningProcess {
  group: number
}

export function outsideGroup(processes: GroupedProcess[], group: number): RunningProcess[] {
  return processes.filter(candidate => candidate.group !== group).map(({ pid, args }) => ({ pid, args }))
}

function psOutsideOwnGroup(): ProcessList {
  const own = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
  return () => outsideGroup(execFileSync('ps', ['-axo', 'pid=,pgid=,args='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), group: Number(match[2]), args: match[3]! }]
  }), own)
}

export function runReducer(cwd: string): string[] {
  const run = spawnSync('pnpm', ['--silent', REDUCE_SCRIPT], { cwd, encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').filter(line => line !== '')
  return run.status === 0 ? output : [...output, `${PREFIX}${REDUCE_SCRIPT} exited ${run.status ?? run.error?.message ?? 'without a status'}`]
}

export type BgCommand
  = | { kind: 'start' }
    | { kind: 'supervise' }
    | { kind: 'switch', worker: string, on: boolean }
    | { kind: 'detection', worker: string, live: boolean }

export function bgCommand(argv: string[]): BgCommand {
  if (argv.includes(SUPERVISE_FLAG))
    return { kind: 'supervise' }
  for (const [flag, on] of [[ON_FLAG, true], [OFF_FLAG, false]] as const) {
    const index = argv.indexOf(flag)
    if (index !== -1)
      return { kind: 'switch', worker: argv[index + 1] ?? '', on }
  }
  for (const [flag, live] of [[LIVE_ON_FLAG, true], [LIVE_OFF_FLAG, false]] as const) {
    const index = argv.indexOf(flag)
    if (index !== -1)
      return { kind: 'detection', worker: argv[index + 1] ?? '', live }
  }
  return { kind: 'start' }
}

export function detectionCommand(busDir: string, worker: string, live: boolean, decisions: readonly InForceDecision[]): BgResult {
  if (!isBusWorker(worker))
    return { stdout: [], stderr: [`${PREFIX}${worker === '' ? 'no worker named' : `unknown worker ${worker}`}; one of ${WORKERS.join(', ')}`], exitCode: 1 }
  if (live && liveDecisionOf(decisions, worker) === null)
    return { stdout: [], stderr: [`${PREFIX}${worker} is not switched live: no owner decision in force names it; record one with ${allowLiveCommand(worker)}`], exitCode: 1 }
  const now = switchDetection(busDir, worker, live)
  return { stdout: [`${PREFIX}detecting live: ${now.join(', ') || 'none'}; every other worker detects in shadow, and a worker already running changes mode when it is switched off and on`], stderr: [], exitCode: 0 }
}

export function switchCommand(busDir: string, worker: string, on: boolean): BgResult {
  if (!isBusWorker(worker))
    return { stdout: [], stderr: [`${PREFIX}${worker === '' ? 'no worker named' : `unknown worker ${worker}`}; one of ${WORKERS.join(', ')}`], exitCode: 1 }
  const now = switchWorker(busDir, worker, on)
  return { stdout: [`${PREFIX}switched on: ${now.join(', ') || 'none'}; the supervisor starts what is switched on and stops what is switched off on its next tick`], stderr: [], exitCode: 0 }
}

export interface SwitchControl {
  processes: ProcessList
  start: (launch: DetachedLaunch) => BgResult
  stop: (running: RunningProcess, launch: DetachedLaunch) => Promise<void>
}

async function supervise(busDir: string, cwd: string, reviewPreflight: () => string[]): Promise<number> {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const processes = psList()
  const journal = (entry: Record<string, unknown>): void => {
    appendFileSync(path.join(busDir, SUPERVISOR_JOURNAL), `${JSON.stringify(entry)}\n`)
  }
  const code = gitCode(cwd)
  recordStarted(db, new Date().toISOString(), code, line => console.log(line))
  const supervisor = new BusSupervisor({
    known: busLaunches(reviewPreflight),
    wanted: () => wantedLaunches(busDir, reviewPreflight, inForceDecisions(db)),
    start: launch => startReviewWorker(launch, busDir, process.env, processes),
    stop: (running, launch) => stopInstance(running, launch.markers, processes),
    freeLeases: stopped => freeLeasesOf(db, new Date().toISOString(), stopped),
    drain: busDrain(db, () => new Date().toISOString(), psStartOf),
    processes,
    mainSince: afterId => mainAdvancedSince(db, afterId),
    code,
    journal,
    missed: (sha, waitedMs) => recordRestartMissed(db, new Date().toISOString(), sha, waitedMs),
    now: () => Date.now(),
  }, startingBaseline(db, code))
  const keeper = new WorkerKeeper({
    wanted: () => wantedLaunches(busDir, reviewPreflight, inForceDecisions(db)),
    start: launch => startReviewWorker(launch, busDir, process.env, processes),
    processes,
    reduce: () => runReducer(cwd),
    journal,
    down: down => recordWorkerDown(db, new Date().toISOString(), down),
    now: () => Date.now(),
  })
  console.log(`${PREFIX}supervising the bus processes over ${busPath}: a main.advanced or a move of the local ${LOCAL_MAIN_REF} restarts, once ${cwd} holds it, each bus process whose code it changed, and this supervisor when its own code changed, and each tick starts a switched-on worker that is not running and stops a switched-off one that is`)
  try {
    await superviseUntilReplaced({
      supervisor,
      keeper,
      judge: new LivenessJudge(db, () => Date.now(), () => expectedRunning(db, wantedLaunches(busDir, reviewPreflight, inForceDecisions(db))), name => restartSilent(name, wantedLaunches(busDir, reviewPreflight, inForceDecisions(db)), {
        processes,
        start: launch => startReviewWorker(launch, busDir, process.env, processes),
        stop: (running, launch) => stopInstance(running, launch.markers, processes),
      }), psStartOf),
      relaunch: () => startDetached(SUPERVISOR_LAUNCH, busDir, process.env, psOutsideOwnGroup()),
      print: line => console.log(line),
      pause: () => sleep(CHECK_MS),
    })
    return 0
  }
  finally {
    db.close()
  }
}

function decisionsInForce(): InForceDecision[] {
  const db = openBus(defaultBusPath())
  try {
    return inForceDecisions(db)
  }
  finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const busDir = busDirOf(pinBus(process.env, os.homedir(), process.cwd()))
  const cwd = process.cwd()
  const reviewPreflight = (): string[] => busShadowProblems(defaultBusPath())
  const command = bgCommand(process.argv.slice(2))
  if (command.kind === 'supervise') {
    process.exitCode = await supervise(busDir, cwd, reviewPreflight)
    return
  }
  if (command.kind === 'switch') {
    printBg(switchCommand(busDir, command.worker, command.on))
    return
  }
  if (command.kind === 'detection') {
    printBg(detectionCommand(busDir, command.worker, command.live, command.live ? decisionsInForce() : []))
    return
  }
  const processes = psList()
  for (const line of await restartSilentSupervisorOnBus(busDir, processes))
    console.log(line)
  printBg(runBusBg(busDir, [...wantedLaunches(busDir, reviewPreflight, decisionsInForce()), SUPERVISOR_LAUNCH], process.env, processes, startReviewWorker))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  await main()
}
