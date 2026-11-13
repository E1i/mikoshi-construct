import type { DatabaseSync } from 'node:sqlite'
import type { HolderProcess, HolderReading, ProcessStartOf } from '../core/lease.js'
import type { ChildStart, WorkerIdentity } from '../core/node.js'
import type { InForceDecision } from '../policy/decisions/index.js'
import type { ProcessTable } from '../ports/process-table.js'
import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from './bg.js'
import type { ProcessBeat } from './heartbeat.js'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { busDirOf, pinBus, snapshotPathOf } from '../core/bus-path.js'
import { RUNNING_CARD } from '../core/card-automaton.js'
import { appendEvent, defaultBusPath, openBus } from '../core/db.js'
import { CARD_CONTINUED, CARD_STARTED, CHILD_ENDED, CHILD_STARTED, MAIN_ADVANCED, PROCESS_JUDGED, RESTARTED, TASK_EXPIRED, WORKER_DOWN, WORKER_STARTED } from '../core/events.js'
import { FACTORY_NAMED, FACTORY_RUNTIME, FACTORY_WORKERS } from '../core/factory-paths.js'
import { RESTART_MISSED } from '../core/inbox.js'
import { closeDrain, expireLeasesHeldBy, HOLDER_DEAD, HOLDER_UNPROVEN, judgeHolders, LEASE_MS, leasesHeldBy, openDrain, retireHolders, retiringPids, WORKER_HUNG } from '../core/lease.js'
import { EXECUTOR_MODES, GENERATION_VARIABLE, LIVE_FLAG, UNHANDED } from '../core/node.js'
import { inForceDecisions } from '../policy/decisions/index.js'
import { allowLiveCommand, liveDecisionOf } from '../policy/live-decision.js'
import { BusRead } from '../ports/bus-read.js'
import { processGit } from '../ports/git.js'
import { CHECK_MS } from '../ports/netwatch.js'
import { OsProcessTable, rowOf, rowsOf, runningAs } from '../ports/process-table.js'
import { WindowSessionEnds } from '../window/window-session-end.js'
import { BUILD_DIR, BUILT_MODULE, BUS_RUN_LAUNCH, carriesMarker, flagsInArgs, installedPackage, instancesOf, launchName, PREFIX, printBg, provenOnBus, runBusBg, runningInstance, stampedOtherwise, startDetached, thisBus, withBuses } from './bg.js'
import { BusHealer, CorruptionWatch, RecordedNodes } from './bus-heal.js'
import { BusSnapshot } from './bus-snapshot.js'
import { busProjections } from './composition.js'
import { CARD_PROCESS, lastProcessBeats, recordProcessHeartbeat } from './heartbeat.js'
import { beatsLive, SILENT_MS } from './liveness-sites.js'
import { busShadowProblems, startReviewWorker } from './review-bg.js'
import { stampLogOutput } from './stamp.js'
import { WindowSubagentTick } from './window-subagent-tick.js'
import { busLaunches, isBusWorker, ROUND_WORKERS, switchDetection, switchWorker, wantedLaunches, WORKERS } from './workers.js'

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
  markers: [`${FACTORY_RUNTIME.busSupervisor} ${SUPERVISE_FLAG}`, `--silent bus:bg ${SUPERVISE_FLAG}`],
  instanceFile: SUPERVISOR_INSTANCE_FILE,
  startLock: 'bus-bg-supervise.lock',
  log: 'supervisor.log',
}

const BUILT_BUS_ENTRIES = [FACTORY_RUNTIME.busRunEntry, FACTORY_RUNTIME.busSupervisor, ...Object.values(FACTORY_WORKERS)]
  .map(entry => `/${BUILD_DIR}/${entry.replace(/\.ts$/, BUILT_MODULE)}`)

export function packageOfBusProcess(args: string): string | null {
  for (const token of args.split(/\s+/)) {
    const entry = BUILT_BUS_ENTRIES.find(built => token.endsWith(built))
    if (entry !== undefined)
      return token.slice(0, -entry.length)
  }
  return null
}

export function foreignBusLines(processes: readonly RunningProcess[], ownPackage: string): string[] {
  return processes.flatMap((candidate) => {
    const root = packageOfBusProcess(candidate.args)
    return root === null || path.resolve(root) === path.resolve(ownPackage)
      ? []
      : [`${PREFIX}pid ${candidate.pid} is a bus process from another package, ${root}, not from ${path.resolve(ownPackage)}: this supervisor neither counts nor stops it; kill ${candidate.pid} once nothing of that package should run`]
  })
}

const ownPackage = (): string => installedPackage() ?? process.cwd()

export interface MainAdvance {
  id: number
  sha: string
}

export function lastMainAdvance(db: DatabaseSync): number {
  return Number((db.prepare(`SELECT coalesce(max(id), 0) AS id FROM events WHERE type = '${MAIN_ADVANCED}'`).get() as { id: number }).id)
}

export function mainAdvancedSince(db: DatabaseSync, afterId: number): MainAdvance[] {
  return db.prepare(`SELECT id, payload FROM events WHERE type = '${MAIN_ADVANCED}' AND id > ? ORDER BY id`).all(afterId).flatMap((row) => {
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

export const SHARED_BUS_CODE: readonly string[] = [FACTORY_NAMED.busDatabase, FACTORY_NAMED.busNode, FACTORY_NAMED.busLease, FACTORY_NAMED.busQueue, FACTORY_NAMED.busReducer]

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
  return {
    head: () => processGit.read(cwd, ['rev-parse', 'HEAD']).trim(),
    localMain: () => processGit.readOrNull(cwd, ['rev-parse', '--verify', '--quiet', LOCAL_MAIN_REF])?.trim() ?? null,
    holds: sha => processGit.succeeds(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']),
    pull: () => {
      processGit.read(cwd, ['pull', '--ff-only', '--quiet'], { timeoutMs: GIT_PULL_TIMEOUT_MS })
    },
    changedSince: sha => processGit.read(cwd, ['diff', '--name-only', sha, 'HEAD']).split('\n').filter(file => file !== ''),
    runs: entry => new Set([...importClosure(entry, readable(cwd)), ...SHARED_BUS_CODE]),
  }
}

export function signal(pid: number, name: NodeJS.Signals): void {
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

export async function stopInstance(running: RunningProcess, processes: ProcessList, pause: (ms: number) => Promise<unknown> = sleep): Promise<void> {
  const stillRunning = (): boolean => processes().some(candidate => candidate.pid === running.pid)
  signal(running.pid, 'SIGTERM')
  for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
    if (!stillRunning())
      return
    await pause(STOP_POLL_MS)
  }
  if (stillRunning())
    signal(running.pid, 'SIGKILL')
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
  retire: (launch: DetachedLaunch, pids: readonly number[], sha: string, from: string) => string[]
  open: (sha: string, untilMs: number, draining: DetachedLaunch[], from: string) => void
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
  free: DetachedLaunch[]
}

interface EarlyRestart {
  sha: string
  scripts: Set<string>
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
  private early: EarlyRestart | null = null
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
      return instance !== undefined && flagsInArgs(instance.args).includes(LIVE_FLAG) !== launch.args.includes(LIVE_FLAG) ? [{ launch, instance }] : []
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
    lines.push(...this.retireRounds(scope.launches, head))
    const drained = this.drain(head, scope)
    if (drained.waits)
      return [...lines, ...drained.lines, ...await this.restartEarly(drained.free, head)]
    const restarted = await this.restart({ ...scope, launches: scope.launches.filter(launch => !this.restartedEarly(launch, head)) }, head)
    this.draining = null
    this.early = null
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

  private restartedEarly(launch: DetachedLaunch, head: string): boolean {
    return this.early?.sha === head && this.early.scripts.has(launch.script)
  }

  private async restartEarly(free: DetachedLaunch[], head: string): Promise<string[]> {
    if (free.length === 0)
      return []
    if (this.early?.sha !== head)
      this.early = { sha: head, scripts: new Set() }
    for (const launch of free)
      this.early.scripts.add(launch.script)
    const relaunched = await this.relaunch(free, head, () => {})
    const notBack = relaunched.down.length === 0 ? '' : `; not brought back: ${relaunched.down.join(', ')}`
    return [`${PREFIX}${free.map(launchName).join(', ')} hold no lease in flight; restarted on ${head} at once, and they lease new tasks while the drain waits${notBack}`, ...relaunched.lines]
  }

  private retireRounds(launches: DetachedLaunch[], head: string): string[] {
    const drain = this.parts.drain
    if (drain === undefined)
      return []
    return launches.filter(launch => workerKindsOf([launch]).some(kind => ROUND_WORKERS.includes(kind))).flatMap((launch) => {
      const pids = instancesOf(this.parts.processes(), launch.markers).map(each => each.pid)
      const rounds = drain.retire(launch, pids, head, this.codeSha)
      return rounds.length === 0 ? [] : [`${PREFIX}${launchName(launch)} (pid ${pids.join(', ')}) finishes the rounds it holds on ${this.codeSha} and exits, and new leases go to the worker on ${head}: ${rounds.join(', ')}`]
    })
  }

  private drain(head: string, scope: RestartScope): Drained {
    const drain = this.parts.drain
    if (drain === undefined)
      return { waits: false, lines: [], free: [] }
    const processes = this.parts.processes()
    const holding = scope.launches.flatMap((launch) => {
      const keys = runningInstance(processes, launch.markers) === undefined ? [] : drain.held([launch])
      return keys.length === 0 ? [] : [{ launch, keys }]
    })
    const held = holding.flatMap(holder => holder.keys)
    const draining = this.draining
    if (held.length === 0) {
      this.draining = null
      return { waits: false, lines: [], free: [] }
    }
    const holders = holding.map(holder => holder.launch)
    const free = scope.launches.filter(launch => !holders.includes(launch) && !this.restartedEarly(launch, head))
    const now = this.parts.now()
    if (draining?.sha !== head) {
      const since = draining?.since ?? now
      drain.open(head, since + DRAIN_LIMIT_MS, holders, this.codeSha)
      this.opened = [...new Set([...this.opened, ...holders])]
      this.draining = { sha: head, since }
      const takers = holders.length === this.parts.known.length ? 'no worker takes a new one' : `${holders.map(launch => launch.script).join(', ')} take no new one`
      if (now - since < DRAIN_LIMIT_MS)
        return { waits: true, free, lines: [`${PREFIX}the restart onto ${head} waits for the leases in flight to finish, and ${takers}: ${held.join(', ')}`] }
    }
    else if (now - draining.since < DRAIN_LIMIT_MS) {
      return { waits: true, free, lines: [] }
    }
    return { waits: false, free: [], lines: [`${PREFIX}the leases in flight did not finish within ${DRAIN_LIMIT_MS / 60_000} min; restarting on ${head} anyway, and these are freed as ${TASK_EXPIRED}: ${held.join(', ')}`] }
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
    return this.relaunch(scope.launches, head, () => {
      if (!scope.self && this.opened.length > 0)
        this.parts.drain?.close(head, this.opened)
      this.opened = []
    })
  }

  private async relaunch(launches: DetachedLaunch[], head: string, beforeStart: () => void): Promise<Restarted> {
    const scripts = new Set(launches.map(launch => launch.script))
    const wanted = this.parts.wanted().filter(launch => scripts.has(launch.script))
    const processes = this.parts.processes()
    const running = launches.flatMap((launch) => {
      const instance = runningInstance(processes, launch.markers)
      return instance === undefined ? [] : [{ launch, instance }]
    })
    const retired: { launch: DetachedLaunch, rounds: string[] }[] = []
    for (const { launch, instance } of running) {
      const rounds = this.retireRounds([launch], head)
      retired.push({ launch, rounds })
      if (rounds.length === 0)
        await this.parts.stop(instance, launch)
    }
    const stopped = retired.filter(each => each.rounds.length === 0).map(each => each.launch)
    const freed = [...retired.flatMap(each => each.rounds), ...this.parts.freeLeases?.(stopped) ?? []]
    beforeStart()
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

export function withoutRetiring(processes: () => (RunningProcess & Partial<GroupedProcess>)[], db: DatabaseSync, holding: () => boolean = () => false): ProcessList {
  return () => {
    const listed = processes()
    if (holding())
      return listed
    const retiring = retiringPids(db)
    return listed.filter(each => !retiring.has(each.pid) && !retiring.has(each.group ?? each.pid))
  }
}

export function lstartToIso(line: string): string | null {
  const ms = Date.parse(line.trim())
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

export function psStartOf(pid: number, table: ProcessTable = new OsProcessTable()): HolderProcess {
  const snapshot = table.snapshot()
  if (!snapshot.readable)
    return { state: 'unreadable' }
  const row = rowOf(snapshot, pid)
  if (row === null)
    return { state: 'gone' }
  const started = lstartToIso(row.started)
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
        judgeHolders(db, ts(), startOf, SILENT_MS)
      return leasesHeldBy(db, workerKindsOf(running))
    },
    retire: (launch, pids, sha, from) => workerKindsOf([launch]).flatMap(node => retireHolders(db, ts(), { node, pids, sha, from })),
    open: (sha, untilMs, draining, from) => {
      const at = ts()
      for (const node of workerKindsOf(draining))
        openDrain(db, at, sha, new Date(untilMs).toISOString(), node, from)
    },
    close: (sha, drained) => {
      const at = ts()
      for (const node of workerKindsOf(drained))
        closeDrain(db, at, sha, node)
    },
  }
}

export function freeLeasesOf(db: DatabaseSync, ts: string, stopped: DetachedLaunch[]): string[] {
  const freed = expireLeasesHeldBy(db, ts, workerKindsOf(stopped), SILENT_MS)
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

export const processName = (launch: DetachedLaunch): string => launch.script

export function expectedRunning(db: DatabaseSync, wanted: readonly DetachedLaunch[]): ExpectedRunning {
  const names = new Set([SUPERVISOR_PROCESS, ...wanted.map(processName), ...(db.prepare(RUNNING_CARDS).all() as { card_id: number }[]).map(row => `${CARD_PROCESS}${row.card_id}`)])
  return name => names.has(name)
}

export function judgeSilent(beats: readonly ProcessBeat[], nowMs: number, expected: ExpectedRunning): Judgement[] {
  return beats.filter(beat => expected(beat.process) && !beatsLive(beat.ts, nowMs) && nowMs - Date.parse(beat.ts) <= JUDGED_HORIZON_MS).map(beat => ({ process: beat.process, lastBeat: beat.ts, silentMs: nowMs - Date.parse(beat.ts) }))
}

const CARD_LIFE_STARTS = `
  SELECT '${CARD_PROCESS}' || card_id AS name, max(ts) AS ts FROM events
  WHERE type IN ('${CARD_STARTED}', '${CARD_CONTINUED}') AND legacy = 0 AND card_id IS NOT NULL
  GROUP BY card_id
`

export function currentLifeBeats(db: DatabaseSync, beats: readonly ProcessBeat[]): ProcessBeat[] {
  const lifeStarts = new Map((db.prepare(CARD_LIFE_STARTS).all() as { name: string, ts: string }[]).map(row => [row.name, row.ts]))
  return beats.map((beat) => {
    const lifeStart = lifeStarts.get(beat.process)
    return lifeStart !== undefined && lifeStart > beat.ts ? { process: beat.process, ts: lifeStart } : beat
  })
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
      const silent = judgeSilent(currentLifeBeats(this.db, lastProcessBeats(this.db)), nowMs, this.expected())
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
        lines.push(...holderLines(judgeHolders(this.db, ts, this.startOf, SILENT_MS)))
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
    return await restartSilentSupervisor({ db, now: () => Date.now(), startedAt: () => startedAtOf(path.join(busDir, SUPERVISOR_INSTANCE_FILE)), processes, stop: running => stopInstance(running, processes) })
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
  heal?: BusHealer
  snapshot?: BusSnapshot
  windowEnds?: WindowSessionEnds
  windowSubagents?: Pick<WindowSubagentTick, 'step'>
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
    const ticked = [...lines, ...replacement.lines, ...replacement.replaced ? [] : [...parts.keeper.step(), ...await parts.judge?.step() ?? [], ...parts.windowEnds?.step() ?? [], ...parts.windowSubagents?.step() ?? []]]
    for (const line of [...ticked, ...await parts.heal?.step(ticked) ?? [], ...parts.snapshot?.step() ?? []])
      parts.print(line)
    if (replacement.replaced)
      return
    await parts.pause()
  }
}

export interface GroupedProcess extends RunningProcess {
  group: number
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function datable(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function text(value: unknown, otherwise: string): string {
  return typeof value === 'string' ? value : otherwise
}

export function recordedWorkers(db: DatabaseSync): WorkerIdentity[] {
  const latest = new Map<string, WorkerIdentity>()
  for (const { fields } of new BusRead(db).slice(WORKER_STARTED, ['worker', 'pid', 'started', 'instance', 'generation', 'pgid', 'lstart'])) {
    if (typeof fields.worker !== 'string' || !positive(fields.pid) || !datable(fields.started))
      continue
    latest.set(fields.worker, {
      worker: fields.worker,
      pid: fields.pid,
      started: fields.started,
      instance: text(fields.instance, UNHANDED),
      generation: text(fields.generation, UNHANDED),
      pgid: positive(fields.pgid) ? fields.pgid : null,
      lstart: datable(fields.lstart) ? fields.lstart : fields.started,
    })
  }
  return [...latest.values()]
}

const childKey = (instance: unknown, pid: unknown, taskKey: unknown): string => JSON.stringify([instance, pid, taskKey])

export function childrenNotEnded(db: DatabaseSync): ChildStart[] {
  const read = new BusRead(db)
  const endedAt = new Map(read.slice(CHILD_ENDED, ['instance', 'pid', 'task_key']).map(ended => [childKey(ended.fields.instance, ended.fields.pid, ended.fields.task_key), ended.id]))
  return read.slice(CHILD_STARTED, ['mode', 'instance', 'generation', 'pid', 'pgid', 'lstart', 'kind', 'task_key', 'tree']).flatMap(({ id, fields }) => {
    const mode = EXECUTOR_MODES.find(each => each === fields.mode)
    const ended = endedAt.get(childKey(fields.instance, fields.pid, fields.task_key))
    if ((ended !== undefined && ended > id) || mode === undefined || !positive(fields.pid) || !positive(fields.pgid) || !datable(fields.lstart) || typeof fields.instance !== 'string' || typeof fields.task_key !== 'string')
      return []
    return [{ mode, instance: fields.instance, generation: text(fields.generation, UNHANDED), pid: fields.pid, pgid: fields.pgid, lstart: fields.lstart, kind: text(fields.kind, ''), taskKey: fields.task_key, tree: typeof fields.tree === 'string' ? fields.tree : null }]
  })
}

export const UNRECORDED_LAUNCHES: readonly DetachedLaunch[] = [BUS_RUN_LAUNCH, SUPERVISOR_LAUNCH]

export function identifiedProcesses(table: ProcessTable, db: DatabaseSync, unrecorded: readonly DetachedLaunch[] = UNRECORDED_LAUNCHES): () => GroupedProcess[] {
  return () => {
    const snapshot = table.snapshot()
    const rows = rowsOf(snapshot)
    const children = new Set(childrenNotEnded(db).flatMap(child => runningAs(snapshot, child) === null ? [] : [child.pid]))
    const workers = recordedWorkers(db).flatMap((worker) => {
      const row = runningAs(snapshot, worker)
      return row === null || children.has(row.pid) ? [] : [row]
    })
    const recorded = new Set(workers.map(row => row.pid))
    const launched = rows.filter(row => !recorded.has(row.pid) && !children.has(row.pid) && unrecorded.some(launch => carriesMarker(row.command, launch.markers)))
    return withBuses([...workers, ...launched].map(row => ({ pid: row.pid, group: row.pgid, args: row.command })))
  }
}

export function generationEnv(code: Pick<BusCode, 'head'>, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  try {
    return { ...env, [GENERATION_VARIABLE]: code.head() }
  }
  catch {
    return { ...env, [GENERATION_VARIABLE]: UNHANDED }
  }
}

export function outsideGroup(processes: GroupedProcess[], group: number): RunningProcess[] {
  return processes.filter(candidate => candidate.group !== group).map(({ group: _group, ...running }) => running)
}

export function groupedPsList(table: ProcessTable = new OsProcessTable()): () => GroupedProcess[] {
  return () => withBuses(rowsOf(table.snapshot()).map(row => ({ pid: row.pid, group: row.pgid, args: row.command })))
}

export function outsideOwnGroup(table: ProcessTable = new OsProcessTable(), self: number = process.pid): ProcessList {
  const own = rowOf(table.snapshot(), self)?.pgid ?? self
  return () => outsideGroup(groupedPsList(table)(), own)
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
  const everyProcess = identifiedProcesses(new OsProcessTable(), db)
  const journal = (entry: Record<string, unknown>): void => {
    appendFileSync(path.join(busDir, SUPERVISOR_JOURNAL), `${JSON.stringify(entry)}\n`)
  }
  const code = gitCode(cwd)
  const known = busLaunches(reviewPreflight)
  const nodes = new RecordedNodes(busPath, {
    signal,
    runsNodeOfThisBus: (pid, script) => known.some(launch => launch.script === script && instancesOf(everyProcess(), launch.markers).some(each => each.pid === pid && provenOnBus(each, thisBus()))),
    runningOnThisBus: () => known.flatMap(launch => instancesOf(everyProcess(), launch.markers).map(each => `${launch.script} (pid ${each.pid})`)),
    pause: sleep,
    now: () => new Date(),
  })
  const processes = withoutRetiring(everyProcess, db, () => nodes.held())
  const start = (launch: DetachedLaunch): BgResult => nodes.started(launch, startReviewWorker(launch, busDir, generationEnv(code), processes))
  const wanted = (): DetachedLaunch[] => nodes.held() ? [] : wantedLaunches(busDir, reviewPreflight, inForceDecisions(db))
  foreignBusLines(groupedPsList()(), ownPackage()).forEach(line => console.log(line))
  recordStarted(db, new Date().toISOString(), code, line => console.log(line))
  const supervisor = new BusSupervisor({
    known: busLaunches(reviewPreflight),
    wanted,
    start,
    stop: running => stopInstance(running, processes),
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
    wanted,
    start,
    processes,
    reduce: () => runReducer(cwd),
    journal,
    down: down => recordWorkerDown(db, new Date().toISOString(), down),
    now: () => Date.now(),
  })
  const restartJudged = (name: string): Promise<string[]> => restartSilent(name, wanted(), { processes, start, stop: running => stopInstance(running, processes) })
  console.log(`${PREFIX}supervising the bus processes over ${busPath}: a main.advanced or a move of the local ${LOCAL_MAIN_REF} restarts, once ${cwd} holds it, each bus process whose code it changed, and this supervisor when its own code changed, and each tick starts a switched-on worker that is not running and stops a switched-off one that is`)
  try {
    await superviseUntilReplaced({
      supervisor,
      keeper,
      judge: new LivenessJudge(db, () => Date.now(), () => expectedRunning(db, wanted()), restartJudged, psStartOf),
      windowEnds: new WindowSessionEnds(db, cwd, () => Date.now(), PREFIX),
      windowSubagents: new WindowSubagentTick(db, cwd, () => Date.now(), PREFIX),
      heal: new BusHealer({ busPath, nodes, now: () => new Date(), projections: busProjections(), watch: new CorruptionWatch(busLaunches(reviewPreflight).map(launch => path.join(busDir, launch.log))) }),
      snapshot: new BusSnapshot({ db, busPath, file: snapshotPathOf(busPath), now: () => Date.now(), paused: () => nodes.held() }),
      relaunch: () => startDetached(SUPERVISOR_LAUNCH, busDir, process.env, outsideOwnGroup()),
      print: line => console.log(line),
      pause: () => sleep(CHECK_MS),
    })
    return 0
  }
  finally {
    db.close()
  }
}

function onBus<T>(read: (db: DatabaseSync) => T): T {
  const db = openBus(defaultBusPath())
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

function decisionsInForce(): InForceDecision[] {
  return onBus(inForceDecisions)
}

export function pinnedBusDir(): string {
  return busDirOf(pinBus(process.env, os.homedir(), process.cwd()))
}

const reviewPreflight = (): string[] => busShadowProblems(defaultBusPath())

export interface AgentHand {
  env: NodeJS.ProcessEnv
  processes: ProcessList
  ownPackage: string
  stop: (running: RunningProcess, launch: DetachedLaunch) => Promise<void>
  freeLeases: (stopped: DetachedLaunch[]) => string[]
  start?: Parameters<typeof runBusBg>[4]
}

function restampable(instance: RunningProcess, hand: AgentHand): boolean {
  const root = packageOfBusProcess(instance.args)
  return provenOnBus(instance, thisBus(hand.env))
    && (root === null || path.resolve(root) === path.resolve(hand.ownPackage))
    && stampedOtherwise(instance, hand.env)
}

export async function startUnderAgentEnv(busDir: string, launches: DetachedLaunch[], hand: AgentHand): Promise<BgResult> {
  const processes = hand.processes()
  const stale = [...launches].reverse().flatMap((launch) => {
    const instance = runningInstance(processes, launch.markers, thisBus(hand.env))
    return instance !== undefined && restampable(instance, hand) ? [{ launch, instance }] : []
  })
  const lines: string[] = []
  for (const { launch, instance } of stale) {
    await hand.stop(instance, launch)
    lines.push(`${PREFIX}${launchName(launch)} ran as pid ${instance.pid} on another agent env than this start was handed; stopped it to start it again on the handed env`)
  }
  const freed = stale.length === 0 ? [] : hand.freeLeases(stale.map(({ launch }) => launch))
  const started = runBusBg(busDir, launches, hand.env, hand.processes, hand.start)
  return { ...started, stdout: [...lines, ...freed, ...started.stdout] }
}

function freeLeasesOnBus(stopped: DetachedLaunch[]): string[] {
  return onBus(db => freeLeasesOf(db, new Date().toISOString(), stopped))
}

function withoutRetiringOnBus(processes: () => (RunningProcess & Partial<GroupedProcess>)[]): ProcessList {
  return () => onBus(db => withoutRetiring(processes, db)())
}

function identifiedOnBus(table: ProcessTable = new OsProcessTable()): () => GroupedProcess[] {
  return () => onBus(db => identifiedProcesses(table, db)())
}

export async function startBus(busDir: string = pinnedBusDir(), everyProcess: () => (RunningProcess & Partial<GroupedProcess>)[] = identifiedOnBus()): Promise<BgResult> {
  const processes = withoutRetiringOnBus(everyProcess)
  const judged = await restartSilentSupervisorOnBus(busDir, everyProcess)
  const started = await startUnderAgentEnv(busDir, [...wantedLaunches(busDir, reviewPreflight, decisionsInForce()), SUPERVISOR_LAUNCH], {
    env: generationEnv(gitCode(process.cwd())),
    processes,
    ownPackage: ownPackage(),
    stop: running => stopInstance(running, processes),
    freeLeases: freeLeasesOnBus,
    start: startReviewWorker,
  })
  return { ...started, stdout: [...foreignBusLines(groupedPsList()(), ownPackage()), ...judged, ...started.stdout] }
}

async function main(): Promise<void> {
  const busDir = pinnedBusDir()
  const command = bgCommand(process.argv.slice(2))
  if (command.kind === 'supervise') {
    process.exitCode = await supervise(busDir, process.cwd(), reviewPreflight)
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
  printBg(await startBus(busDir))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  await main()
}
