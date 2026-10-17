import type { DatabaseSync } from 'node:sqlite'
import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from './bg.js'
import type { InForceDecision } from './decisions.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { launchName, PREFIX, printBg, psList, runBusBg, runningInstance, startDetached } from './bg.js'
import { defaultBusPath, openBus } from './db.js'
import { inForceDecisions } from './decisions.js'
import { ghApi } from './github.js'
import { expireLeasesHeldBy, TASK_EXPIRED } from './lease.js'
import { allowLiveCommand, liveDecisionOf } from './live-decision.js'
import { CHECK_MS } from './netwatch.js'
import { LIVE_FLAG } from './node.js'
import { busShadowProblems } from './review-bg.js'
import { busLaunches, isBusWorker, switchDetection, switchWorker, wantedLaunches, WORKERS } from './workers.js'

export const SUPERVISE_FLAG = '--supervise'
export const ON_FLAG = '--on'
export const OFF_FLAG = '--off'
export const LIVE_ON_FLAG = '--live'
export const LIVE_OFF_FLAG = '--shadow'
export const BUS_CODE_PATH = 'scripts/bus'
export const STOP_WAIT_MS = 10_000
export const STOP_POLL_MS = 100

export const SUPERVISOR_LAUNCH: DetachedLaunch = {
  prefix: PREFIX,
  script: 'bus:bg',
  args: [SUPERVISE_FLAG],
  markers: [`scripts/bus/supervisor.ts ${SUPERVISE_FLAG}`, `--silent bus:bg ${SUPERVISE_FLAG}`],
  instanceFile: 'bus-bg.pid',
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
  busChangedSince: (sha: string) => boolean
}

export function gitCode(cwd: string): BusCode {
  const git = (args: string[]): number => spawnSync('git', args, { cwd, stdio: 'ignore' }).status ?? -1
  return {
    head: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    holds: sha => git(['merge-base', '--is-ancestor', sha, 'HEAD']) === 0,
    pull: () => {
      execFileSync('git', ['pull', '--ff-only', '--quiet'], { cwd, stdio: 'pipe' })
    },
    busChangedSince: (sha) => {
      const status = git(['diff', '--quiet', sha, 'HEAD', '--', BUS_CODE_PATH])
      if (status !== 0 && status !== 1)
        throw new Error(`git diff ${sha} HEAD -- ${BUS_CODE_PATH} exited ${status}`)
      return status === 1
    },
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
  processes: ProcessList
  mainSince: (afterId: number) => MainAdvance[]
  code: BusCode
  journal: (entry: Record<string, unknown>) => void
  now: () => number
}

interface Restarted {
  lines: string[]
  down: string[]
}

export class BusSupervisor {
  private codeSha: string
  private pending: string | null = null
  private outdatedBy: string | null = null

  constructor(private readonly parts: SupervisorParts, private seen: number) {
    this.codeSha = parts.code.head()
  }

  get ownCodeBehind(): string | null {
    return this.outdatedBy
  }

  async step(): Promise<string[]> {
    try {
      const advanced = await this.advance()
      return [...advanced, ...await this.moveModes()]
    }
    catch (error) {
      const waiting = this.pending === null ? '' : `; main.advanced to ${this.pending} stays pending and is retried on the next tick`
      return [`${PREFIX}supervisor step failed: ${error instanceof Error ? error.message : String(error)}${waiting}`]
    }
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
      const started = this.parts.start(launch)
      lines.push(...started.stdout, ...started.stderr)
    }
    return lines
  }

  private async advance(): Promise<string[]> {
    const advanced = this.parts.mainSince(this.seen)
    const lines: string[] = []
    if (advanced.length > 0) {
      this.seen = advanced.at(-1)!.id
      this.pending = advanced.at(-1)!.sha
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
    const changed = this.parts.code.busChangedSince(this.codeSha)
    const head = this.parts.code.head()
    if (!changed) {
      this.settle(head)
      return [...lines, `${PREFIX}main advanced to ${sha} with no change under ${BUS_CODE_PATH}; nothing restarted`]
    }
    const wanted = this.parts.wanted()
    const restarted = await this.restart(wanted, head)
    this.settle(head)
    this.outdatedBy = head
    const notBack = restarted.down.length === 0 ? '' : `; not brought back: ${restarted.down.join(', ')}`
    return [...lines, `${PREFIX}main advanced to ${sha} with a change under ${BUS_CODE_PATH}; restarting every running bus process on ${head}${notBack}`, ...restarted.lines]
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

  private async restart(wanted: DetachedLaunch[], head: string): Promise<Restarted> {
    const processes = this.parts.processes()
    const running = this.parts.known.flatMap((launch) => {
      const instance = runningInstance(processes, launch.markers)
      return instance === undefined ? [] : [{ launch, instance }]
    })
    for (const { launch, instance } of running)
      await this.parts.stop(instance, launch)
    const stopped = running.map(({ launch }) => launch)
    const freed = this.parts.freeLeases?.(stopped) ?? []
    const again = [...wanted, ...stopped.filter(launch => !wanted.some(want => launchName(want) === launchName(launch)))]
    const down: string[] = []
    const lines = again.flatMap((launch) => {
      const name = launchName(launch)
      const started = this.parts.start(launch)
      if (started.exitCode !== 0 && started.alreadyRunning === undefined) {
        down.push(name)
        this.parts.journal({ ts: new Date(this.parts.now()).toISOString(), event: 'worker.down', worker: name, failures: [causeOf(started)], restart: head })
      }
      return [...started.stdout, ...started.stderr]
    })
    return { lines: [...freed, ...lines], down }
  }
}

export function freeLeasesOf(db: DatabaseSync, ts: string, stopped: DetachedLaunch[]): string[] {
  const kinds = stopped.map(launch => launch.script.replace(/^bus:/, '')).filter(isBusWorker)
  const freed = expireLeasesHeldBy(db, ts, kinds)
  return freed.length === 0 ? [] : [`${PREFIX}freed the leases of the stopped workers at once as ${TASK_EXPIRED}: ${freed.join(', ')}`]
}

export const KEEP_BASE_MS = CHECK_MS
export const KEEP_MAX_MS = 10 * 60_000
export const FAILURES_REPORTED = 3
export const SUPERVISOR_JOURNAL = 'supervisor.jsonl'
export const REDUCE_SCRIPT = 'bus:reduce'

export interface KeeperParts {
  wanted: () => DetachedLaunch[]
  start: (launch: DetachedLaunch) => BgResult
  processes: ProcessList
  reduce: () => string[]
  journal: (entry: Record<string, unknown>) => void
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
    let started = this.parts.start(launch)
    const refusal = started.exitCode !== 0 && refusedByPreflight(launch, started) ? causeOf(started) : null
    if (refusal !== null) {
      lines.push(...started.stderr, `${PREFIX}${name} was refused by the projection preflight; running ${REDUCE_SCRIPT} once and starting it again`, ...this.parts.reduce())
      started = this.parts.start(launch)
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
    return [
      `${PREFIX}${name} failed to start ${causes.length} time(s) in a row; the next attempt in ${Math.round(wait / 1000)}s`,
      ...this.counted(name, { causes, retryAt: this.parts.now() + wait, awaitingSight: false, refused }),
    ]
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

export interface SupervisingParts {
  supervisor: BusSupervisor
  keeper: WorkerKeeper
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
    for (const line of [...lines, ...replacement.lines, ...replacement.replaced ? [] : parts.keeper.step()])
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
  return { stdout: [`${PREFIX}switched on: ${now.join(', ') || 'none'}; pnpm bus:bg starts what is switched on and not running, a restart leaves out what is switched off`], stderr: [], exitCode: 0 }
}

async function supervise(busDir: string, cwd: string, reviewPreflight: () => string[]): Promise<number> {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  const processes = psList()
  const journal = (entry: Record<string, unknown>): void => {
    appendFileSync(path.join(busDir, SUPERVISOR_JOURNAL), `${JSON.stringify(entry)}\n`)
  }
  const supervisor = new BusSupervisor({
    known: busLaunches(reviewPreflight),
    wanted: () => wantedLaunches(busDir, reviewPreflight),
    start: launch => startDetached(launch, busDir, process.env, processes),
    stop: (running, launch) => stopInstance(running, launch.markers, processes),
    freeLeases: stopped => freeLeasesOf(db, new Date().toISOString(), stopped),
    processes,
    mainSince: afterId => mainAdvancedSince(db, afterId),
    code: gitCode(cwd),
    journal,
    now: () => Date.now(),
  }, lastMainAdvance(db))
  const keeper = new WorkerKeeper({
    wanted: () => wantedLaunches(busDir, reviewPreflight),
    start: launch => startDetached(launch, busDir, process.env, processes),
    processes,
    reduce: () => runReducer(cwd),
    journal,
    now: () => Date.now(),
  })
  console.log(`${PREFIX}supervising the bus processes over ${busPath}: a main.advanced with a change under ${BUS_CODE_PATH} restarts them and then this supervisor once ${cwd} holds it, and a switched-on worker that is not running is started again`)
  try {
    await superviseUntilReplaced({
      supervisor,
      keeper,
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
  const busDir = path.join(os.homedir(), '.construct', 'bus')
  const cwd = process.cwd()
  const reviewPreflight = (): string[] => busShadowProblems(defaultBusPath(), ghApi(cwd))
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
  printBg(runBusBg(busDir, [...wantedLaunches(busDir, reviewPreflight), SUPERVISOR_LAUNCH]))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
