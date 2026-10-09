import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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
}

export interface RunningProcess {
  pid: number
  args: string
}

export type ProcessList = () => RunningProcess[]

export function launchArgv(): string[] {
  return ['nohup', 'pnpm', '--silent', RUN_SCRIPT]
}

export function psList(env: NodeJS.ProcessEnv = process.env): ProcessList {
  return () => execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', env })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s(.*)$/.exec(line)
      return match === null ? [] : [{ pid: Number(match[1]), args: match[2]! }]
    })
}

export function runningBus(processes: RunningProcess[]): RunningProcess | undefined {
  return processes.find(candidate => candidate.pid !== process.pid && BUS_RUN_MARKERS.some(marker => candidate.args.includes(marker)))
}

function recordedPid(file: string): number | null {
  if (!existsSync(file))
    return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function alive(pid: number): boolean {
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

export function runBusBg(busDir: string, env: NodeJS.ProcessEnv = process.env, processes: ProcessList = psList(env)): BgResult {
  const instance = path.join(busDir, INSTANCE_FILE)
  const lock = path.join(busDir, START_LOCK)
  const log = path.join(busDir, SHADOW_LOG)
  mkdirSync(busDir, { recursive: true })
  const holder = startHolder(lock)
  if (holder !== null)
    return { stdout: [], stderr: [`${PREFIX}another bus:bg (pid ${holder}) is starting ${RUN_SCRIPT} (${lock}); nothing started`], exitCode: 1 }
  try {
    const running = runningBus(processes())
    if (running !== undefined)
      return { stdout: [], stderr: [`${PREFIX}${RUN_SCRIPT} is already running as pid ${running.pid} (${running.args}); nothing started`], exitCode: 1 }
    const [command, ...args] = launchArgv()
    const fd = openSync(log, 'a')
    try {
      const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env })
      child.on('error', () => {})
      child.unref()
      if (child.pid === undefined)
        return { stdout: [], stderr: [`${PREFIX}${command} did not start`], exitCode: 1 }
      writeFileSync(instance, `${child.pid}\n`)
      return { stdout: [String(child.pid), `${PREFIX}pnpm ${RUN_SCRIPT} · log ${log}`], stderr: [], exitCode: 0 }
    }
    finally {
      closeSync(fd)
    }
  }
  finally {
    rmSync(lock, { force: true })
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runBusBg(path.join(os.homedir(), '.construct', 'bus'))
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
