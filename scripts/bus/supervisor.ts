import type { DatabaseSync } from 'node:sqlite'
import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from './bg.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { launchName, PREFIX, printBg, psList, runBusBg, runningInstance, startDetached } from './bg.js'
import { defaultBusPath, openBus } from './db.js'
import { ghApi } from './github.js'
import { CHECK_MS } from './netwatch.js'
import { busShadowProblems } from './review-bg.js'
import { busLaunches, isBusWorker, switchWorker, wantedLaunches, WORKERS } from './workers.js'

export const SUPERVISE_FLAG = '--supervise'
export const ON_FLAG = '--on'
export const OFF_FLAG = '--off'
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
  processes: ProcessList
  mainSince: (afterId: number) => MainAdvance[]
  code: BusCode
}

export class BusSupervisor {
  private codeSha: string
  private pending: string | null = null

  constructor(private readonly parts: SupervisorParts, private seen: number) {
    this.codeSha = parts.code.head()
  }

  async step(): Promise<string[]> {
    try {
      return await this.advance()
    }
    catch (error) {
      const waiting = this.pending === null ? '' : `; main.advanced to ${this.pending} stays pending and is retried on the next tick`
      return [`${PREFIX}supervisor step failed: ${error instanceof Error ? error.message : String(error)}${waiting}`]
    }
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
    const restarted = await this.restart(wanted)
    this.settle(head)
    return [...lines, `${PREFIX}main advanced to ${sha} with a change under ${BUS_CODE_PATH}; restarting every running bus process on ${head}`, ...restarted]
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

  private async restart(wanted: DetachedLaunch[]): Promise<string[]> {
    const processes = this.parts.processes()
    const running = this.parts.known.flatMap((launch) => {
      const instance = runningInstance(processes, launch.markers)
      return instance === undefined ? [] : [{ launch, instance }]
    })
    for (const { launch, instance } of running)
      await this.parts.stop(instance, launch)
    const again = [...wanted, ...running.map(({ launch }) => launch).filter(launch => !wanted.some(want => launchName(want) === launchName(launch)))]
    return again.flatMap((launch) => {
      const started = this.parts.start(launch)
      return [...started.stdout, ...started.stderr]
    })
  }
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
}

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
      return this.parts.wanted()
        .filter(launch => runningInstance(processes, launch.markers) === undefined)
        .flatMap(launch => this.revive(launch))
    }
    catch (error) {
      return [`${PREFIX}keeping the workers alive failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }

  private revive(launch: DetachedLaunch): string[] {
    const name = launchName(launch)
    const streak = this.streaks.get(name)
    if (streak !== undefined && this.parts.now() < streak.retryAt)
      return []
    const lines = [`${PREFIX}${name} is switched on and not running; starting it`]
    let started = this.parts.start(launch)
    if (started.exitCode !== 0 && refusedByPreflight(launch, started)) {
      lines.push(...started.stderr, `${PREFIX}${name} was refused by the projection preflight; running ${REDUCE_SCRIPT} once and starting it again`, ...this.parts.reduce())
      started = this.parts.start(launch)
    }
    lines.push(...started.stdout, ...started.stderr)
    if (started.exitCode === 0) {
      this.streaks.delete(name)
      return lines
    }
    return [...lines, ...this.failed(name, streak, causeOf(started))]
  }

  private failed(name: string, streak: Streak | undefined, cause: string): string[] {
    const causes = [...streak?.causes ?? [], cause]
    const wait = backoffMs(causes.length)
    this.streaks.set(name, { causes, retryAt: this.parts.now() + wait })
    const next = `${PREFIX}${name} failed to start ${causes.length} time(s) in a row; the next attempt in ${Math.round(wait / 1000)}s`
    if (causes.length !== FAILURES_REPORTED)
      return [next]
    this.parts.journal({ ts: new Date(this.parts.now()).toISOString(), event: 'worker.down', worker: name, failures: causes.slice(-FAILURES_REPORTED) })
    return [next, `${PREFIX}${name} failed ${FAILURES_REPORTED} starts in a row and needs the owner: ${causes.slice(-FAILURES_REPORTED).map((failure, index) => `${index + 1}) ${failure}`).join('; ')}; the supervisor keeps backing off and retrying`]
  }
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

export function bgCommand(argv: string[]): BgCommand {
  if (argv.includes(SUPERVISE_FLAG))
    return { kind: 'supervise' }
  for (const [flag, on] of [[ON_FLAG, true], [OFF_FLAG, false]] as const) {
    const index = argv.indexOf(flag)
    if (index !== -1)
      return { kind: 'switch', worker: argv[index + 1] ?? '', on }
  }
  return { kind: 'start' }
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
  const supervisor = new BusSupervisor({
    known: busLaunches(reviewPreflight),
    wanted: () => wantedLaunches(busDir, reviewPreflight),
    start: launch => startDetached(launch, busDir, process.env, processes),
    stop: (running, launch) => stopInstance(running, launch.markers, processes),
    processes,
    mainSince: afterId => mainAdvancedSince(db, afterId),
    code: gitCode(cwd),
  }, lastMainAdvance(db))
  const keeper = new WorkerKeeper({
    wanted: () => wantedLaunches(busDir, reviewPreflight),
    start: launch => startDetached(launch, busDir, process.env, processes),
    processes,
    reduce: () => runReducer(cwd),
    journal: (entry) => {
      appendFileSync(path.join(busDir, SUPERVISOR_JOURNAL), `${JSON.stringify(entry)}\n`)
    },
    now: () => Date.now(),
  })
  console.log(`${PREFIX}supervising the bus processes over ${busPath}: a main.advanced with a change under ${BUS_CODE_PATH} restarts them once ${cwd} holds it, and a switched-on worker that is not running is started again`)
  try {
    for (;;) {
      for (const line of [...await supervisor.step(), ...keeper.step()])
        console.log(line)
      await sleep(CHECK_MS)
    }
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
  printBg(runBusBg(busDir, [...wantedLaunches(busDir, reviewPreflight), SUPERVISOR_LAUNCH]))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
