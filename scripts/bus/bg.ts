import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const PREFIX = '[bus:bg] '
export const SHADOW_LOG = 'shadow.log'
export const INSTANCE_FILE = 'bus-run.pid'
export const START_LOCK = 'bus-bg.lock'
export const RUN_SCRIPT = 'bus:run'
export const BUS_RUN_MARKERS = ['scripts/bus/run.ts', `--silent ${RUN_SCRIPT}`] as const

export interface BgResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
  alreadyRunning?: RunningProcess
}

export interface RunningProcess {
  pid: number
  args: string
}

export type ProcessList = () => RunningProcess[]

export interface DetachedLaunch {
  prefix: string
  script: string
  args: string[]
  markers: readonly string[]
  instanceFile: string
  startLock: string
  log: string
  preflight?: () => string[]
}

export const BUS_RUN_LAUNCH: DetachedLaunch = {
  prefix: PREFIX,
  script: RUN_SCRIPT,
  args: [],
  markers: BUS_RUN_MARKERS,
  instanceFile: INSTANCE_FILE,
  startLock: START_LOCK,
  log: SHADOW_LOG,
}

export function launchArgv(launch: DetachedLaunch = BUS_RUN_LAUNCH): string[] {
  return ['nohup', 'pnpm', '--silent', launch.script, ...launch.args]
}

export function psList(env: NodeJS.ProcessEnv = process.env): ProcessList {
  return () => execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', env })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s(.*)$/.exec(line)
      return match === null ? [] : [{ pid: Number(match[1]), args: match[2]! }]
    })
}

export function runningInstance(processes: RunningProcess[], markers: readonly string[]): RunningProcess | undefined {
  return processes.find(candidate => candidate.pid !== process.pid && markers.some(marker => candidate.args.includes(marker)))
}

export function runningBus(processes: RunningProcess[]): RunningProcess | undefined {
  return runningInstance(processes, BUS_RUN_MARKERS)
}

function recordedPid(file: string): number | null {
  if (!existsSync(file))
    return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function startHolder(lock: string): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' })
      return null
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
      const holder = recordedPid(lock)
      if (holder !== null && alive(holder))
        return holder
      rmSync(lock, { force: true })
    }
  }
  return recordedPid(lock) ?? 0
}

export function startDetached(launch: DetachedLaunch, busDir: string, env: NodeJS.ProcessEnv = process.env, processes: ProcessList = psList(env)): BgResult {
  const { prefix, script } = launch
  const instance = path.join(busDir, launch.instanceFile)
  const lock = path.join(busDir, launch.startLock)
  const log = path.join(busDir, launch.log)
  mkdirSync(busDir, { recursive: true })
  const holder = startHolder(lock)
  if (holder !== null)
    return { stdout: [], stderr: [`${prefix}another start (pid ${holder}) is starting ${script} (${lock}); nothing started`], exitCode: 1 }
  try {
    const running = runningInstance(processes(), launch.markers)
    if (running !== undefined)
      return { stdout: [], stderr: [`${prefix}${script} is already running as pid ${running.pid} (${running.args}); nothing started`], exitCode: 1, alreadyRunning: running }
    const problems = launch.preflight?.() ?? []
    if (problems.length > 0)
      return { stdout: [], stderr: [`${prefix}refused to start ${script}:`, ...problems.map(problem => `  ${problem}`)], exitCode: 1 }
    const [command, ...args] = launchArgv(launch)
    const fd = openSync(log, 'a')
    try {
      const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env })
      child.on('error', () => {})
      child.unref()
      if (child.pid === undefined)
        return { stdout: [], stderr: [`${prefix}${command} did not start`], exitCode: 1 }
      writeFileSync(instance, `${child.pid}\n`)
      return { stdout: [String(child.pid), `${prefix}pnpm ${[script, ...launch.args].join(' ')} · log ${log}`], stderr: [], exitCode: 0 }
    }
    finally {
      closeSync(fd)
    }
  }
  finally {
    rmSync(lock, { force: true })
  }
}

export function launchName(launch: DetachedLaunch): string {
  return [launch.script, ...launch.args].join(' ')
}

export function runBusBg(busDir: string, launches: DetachedLaunch[], env: NodeJS.ProcessEnv = process.env, processes: ProcessList = psList(env)): BgResult {
  const result: BgResult = { stdout: [], stderr: [], exitCode: 0 }
  for (const launch of launches) {
    const started = startDetached(launch, busDir, env, processes)
    if (started.alreadyRunning !== undefined) {
      result.stdout.push(`${PREFIX}${launchName(launch)} is already running as pid ${started.alreadyRunning.pid}; left alone`)
      continue
    }
    result.stdout.push(...started.stdout)
    result.stderr.push(...started.stderr)
    result.exitCode = Math.max(result.exitCode, started.exitCode)
  }
  return result
}

export function printBg(result: BgResult): void {
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
