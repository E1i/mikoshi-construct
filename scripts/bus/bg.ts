import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PREFIX = '[bus:bg] '
export const SHADOW_LOG = 'shadow.log'
export const INSTANCE_FILE = 'bus-run.pid'
export const RUN_SCRIPT = 'bus:run'

export interface BgResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

export function launchArgv(): string[] {
  return ['nohup', 'pnpm', '--silent', RUN_SCRIPT]
}

function recordedPid(file: string): number | null {
  if (!existsSync(file))
    return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function runsBusRun(pid: number, env: NodeJS.ProcessEnv): boolean {
  try {
    process.kill(pid, 0)
  }
  catch {
    return false
  }
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', env }).includes(RUN_SCRIPT)
  }
  catch {
    return false
  }
}

export function runBusBg(busDir: string, env: NodeJS.ProcessEnv = process.env): BgResult {
  const instance = path.join(busDir, INSTANCE_FILE)
  const log = path.join(busDir, SHADOW_LOG)
  const held = recordedPid(instance)
  if (held !== null && runsBusRun(held, env))
    return { stdout: [], stderr: [`${PREFIX}${RUN_SCRIPT} is already running as pid ${held} (${instance}); nothing started`], exitCode: 1 }
  mkdirSync(busDir, { recursive: true })
  const [command, ...args] = launchArgv()
  const fd = openSync(log, 'a')
  try {
    const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env })
    child.on('error', () => {})
    child.unref()
    if (child.pid === undefined)
      return { stdout: [], stderr: [`${PREFIX}${command} did not start`], exitCode: 1 }
    writeFileSync(instance, `${child.pid}\n`)
    const takenOver = held === null ? '' : ` · took over from dead pid ${held}`
    return { stdout: [String(child.pid), `${PREFIX}pnpm ${RUN_SCRIPT} · log ${log}${takenOver}`], stderr: [], exitCode: 0 }
  }
  finally {
    closeSync(fd)
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
