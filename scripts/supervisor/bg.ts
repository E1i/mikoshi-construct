import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BUS_DB_VARIABLE } from '../core/bus-path.js'
import { FACTORY_RUNTIME } from '../core/factory-paths.js'
import { STAMP_ENV } from './stamp.js'

export const PREFIX = '[bus:bg] '
export const SHADOW_LOG = 'shadow.log'
export const START_LOCK = 'bus-bg.lock'
export const START_LOCK_LIMIT_MS = 10 * 60 * 1000
export const RUN_SCRIPT = 'bus:run'
export const BUS_RUN_MARKERS = [FACTORY_RUNTIME.busRunEntry, `--silent ${RUN_SCRIPT}`] as const
export const BUILD_DIR = 'dist'
export const BUILT_MODULE = '.js'

const FACTORY_SCRIPT = /^node --import tsx (scripts\/[\w/-]+)\.ts(?:\s|$)/
const SOURCE_MARKER = /^(scripts\/[\w/-]+)\.ts(?=\s|$)/
const PS_LINE = /^\s*(\d+)\s(.*)$/
export const BUS_FLAG = '--bus'
const BUS_ARGUMENT = ` ${BUS_FLAG} `

export interface BgResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
  alreadyRunning?: RunningProcess
}

export interface RunningProcess {
  pid: number
  args: string
  bus?: string
}

export type ProcessList = () => RunningProcess[]

export interface DetachedLaunch {
  prefix: string
  script: string
  args: string[]
  markers: readonly string[]
  instanceFile?: string
  startLock: string
  log: string
  preflight?: () => string[]
}

export const BUS_RUN_LAUNCH: DetachedLaunch = {
  prefix: PREFIX,
  script: RUN_SCRIPT,
  args: [],
  markers: BUS_RUN_MARKERS,
  startLock: START_LOCK,
  log: SHADOW_LOG,
}

export function installedPackage(moduleUrl: string = import.meta.url): string | null {
  return moduleUrl.endsWith(BUILT_MODULE) ? fileURLToPath(new URL('../../../', moduleUrl)) : null
}

export function builtEntryOf(root: string, script: string): string {
  const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
  const source = FACTORY_SCRIPT.exec(scripts[script] ?? '')?.[1]
  if (source === undefined)
    throw new Error(`${PREFIX}the package.json of ${root} names no factory entry for ${script}`)
  return path.join(root, BUILD_DIR, `${source}${BUILT_MODULE}`)
}

export function launchArgv(launch: DetachedLaunch = BUS_RUN_LAUNCH, installed: string | null = installedPackage(), bus?: string): string[] {
  const args = bus === undefined ? launch.args : [...launch.args, BUS_FLAG, path.resolve(bus)]
  if (installed === null)
    return ['nohup', 'pnpm', '--silent', launch.script, ...args]
  return ['nohup', process.execPath, builtEntryOf(installed, launch.script), ...args]
}

export function carriesMarker(args: string, markers: readonly string[]): boolean {
  return markers.some(marker => args.includes(marker) || args.includes(marker.replace(SOURCE_MARKER, `$1${BUILT_MODULE}`)))
}

function psLines(args: string[], env: NodeJS.ProcessEnv): RunningProcess[] {
  return parsePs(execFileSync('ps', args, { encoding: 'utf8', env }))
}

function parsePs(output: string): RunningProcess[] {
  return output
    .split('\n')
    .flatMap((line) => {
      const match = PS_LINE.exec(line)
      return match === null ? [] : [{ pid: Number(match[1]), args: match[2]! }]
    })
}

export function busInArgs(args: string): string | undefined {
  const at = args.lastIndexOf(BUS_ARGUMENT)
  const bus = at === -1 ? '' : args.slice(at + BUS_ARGUMENT.length).trim()
  return bus === '' ? undefined : bus
}

export function withBuses<T extends RunningProcess>(processes: T[]): T[] {
  return processes.map((candidate) => {
    const bus = busInArgs(candidate.args)
    return bus === undefined ? candidate : { ...candidate, bus }
  })
}

export function psList(env: NodeJS.ProcessEnv = process.env): ProcessList {
  return () => withBuses(psLines(['-axo', 'pid=,args='], env))
}

export function thisBus(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bus = env[BUS_DB_VARIABLE]
  return bus === undefined || bus === '' ? undefined : bus
}

export function servesBus(candidate: RunningProcess, bus: string | undefined): boolean {
  return bus === undefined || candidate.bus === undefined || !path.isAbsolute(candidate.bus) || path.resolve(candidate.bus) === path.resolve(bus)
}

export function provenOnBus(candidate: RunningProcess, bus: string | undefined): boolean {
  return bus === undefined || (candidate.bus !== undefined && path.isAbsolute(candidate.bus) && path.resolve(candidate.bus) === path.resolve(bus))
}

export function instancesOf(processes: RunningProcess[], markers: readonly string[], bus: string | undefined = thisBus()): RunningProcess[] {
  return processes.filter(candidate => candidate.pid !== process.pid && servesBus(candidate, bus) && carriesMarker(candidate.args, markers))
}

export function runningInstance(processes: RunningProcess[], markers: readonly string[], bus: string | undefined = thisBus()): RunningProcess | undefined {
  return instancesOf(processes, markers, bus)[0]
}

export function runningBus(processes: RunningProcess[]): RunningProcess | undefined {
  return runningInstance(processes, BUS_RUN_MARKERS)
}

interface StartLock { holder: number, mtimeMs: number }

function readStartLock(file: string): StartLock | null {
  try {
    const { mtimeMs } = statSync(file)
    const holder = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(holder) && holder > 0 ? { holder, mtimeMs } : null
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
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

function holdsStart({ holder, mtimeMs }: StartLock, processes: RunningProcess[]): boolean {
  if (Date.now() - mtimeMs > START_LOCK_LIMIT_MS)
    return false
  const ownArgs = processes.find(candidate => candidate.pid === process.pid)?.args
  if (ownArgs === undefined)
    return alive(holder)
  return processes.some(candidate => candidate.pid === holder && candidate.args === ownArgs)
}

function startHolder(lock: string, processes: ProcessList): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' })
      return null
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
      const found = readStartLock(lock)
      if (found !== null && holdsStart(found, processes()))
        return found.holder
      rmSync(lock, { force: true })
    }
  }
  return readStartLock(lock)?.holder ?? 0
}

export function startDetached(launch: DetachedLaunch, busDir: string, env: NodeJS.ProcessEnv = process.env, processes: ProcessList = psList(env)): BgResult {
  const { prefix, script } = launch
  const lock = path.join(busDir, launch.startLock)
  const log = path.join(busDir, launch.log)
  mkdirSync(busDir, { recursive: true })
  const holder = startHolder(lock, processes)
  if (holder !== null)
    return { stdout: [], stderr: [`${prefix}another start (pid ${holder}) is starting ${script} (${lock}); nothing started`], exitCode: 1 }
  try {
    const running = runningInstance(processes(), launch.markers, thisBus(env))
    if (running !== undefined)
      return { stdout: [], stderr: [`${prefix}${script} is already running as pid ${running.pid} (${running.args}); nothing started`], exitCode: 1, alreadyRunning: running }
    const problems = launch.preflight?.() ?? []
    if (problems.length > 0)
      return { stdout: [], stderr: [`${prefix}refused to start ${script}:`, ...problems.map(problem => `  ${problem}`)], exitCode: 1 }
    const [command, ...args] = launchArgv(launch, installedPackage(), thisBus(env))
    const fd = openSync(log, 'a')
    try {
      const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...env, [STAMP_ENV]: '1' } })
      child.on('error', () => {})
      child.unref()
      if (child.pid === undefined)
        return { stdout: [], stderr: [`${prefix}${command} did not start`], exitCode: 1 }
      if (launch.instanceFile !== undefined)
        writeFileSync(path.join(busDir, launch.instanceFile), `${child.pid}\n`)
      return { stdout: [String(child.pid), `${prefix}${args.join(' ')} · log ${log}`], stderr: [], exitCode: 0 }
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

export function runBusBg(busDir: string, launches: DetachedLaunch[], env: NodeJS.ProcessEnv = process.env, processes: ProcessList = psList(env), start: (launch: DetachedLaunch, busDir: string, env: NodeJS.ProcessEnv, processes: ProcessList) => BgResult = startDetached): BgResult {
  const result: BgResult = { stdout: [], stderr: [], exitCode: 0 }
  const bus = thisBus(env)
  let up = 0
  for (const launch of launches) {
    const started = start(launch, busDir, env, processes)
    if (started.alreadyRunning !== undefined) {
      const proven = provenOnBus(started.alreadyRunning, bus)
      up += proven ? 1 : 0
      result.stdout.push(proven
        ? `${PREFIX}${launchName(launch)} is already running as pid ${started.alreadyRunning.pid}; left alone`
        : `${PREFIX}${launchName(launch)} is running as pid ${started.alreadyRunning.pid}, whose bus could not be read as ${bus}; left alone and not counted as running for it`)
      continue
    }
    up += started.exitCode === 0 ? 1 : 0
    result.stdout.push(...started.stdout)
    result.stderr.push(...started.stderr)
    result.exitCode = Math.max(result.exitCode, started.exitCode)
  }
  if (launches.length > 0 && up === 0 && result.exitCode === 0) {
    result.stderr.push(`${PREFIX}started nothing for ${bus ?? busDir} and found nothing of it running; its factory is not up`)
    result.exitCode = 1
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
