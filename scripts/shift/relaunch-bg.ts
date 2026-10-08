import type { BgResult } from './bg.js'
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PREFIX = '[relaunch:bg] '
export const USAGE = 'usage: pnpm relaunch:bg <handoff.md> [relaunch arguments]'
export const RELAUNCH_LOG = path.join('.construct', 'handoff', 'relaunch-day.log')

export function launchArgv(relaunchArgs: string[]): string[] {
  return ['nohup', 'pnpm', 'relaunch', ...relaunchArgs]
}

export function runRelaunchBg(argv: string[], env: NodeJS.ProcessEnv = process.env): BgResult {
  const handoff = argv[0]
  if (handoff === undefined || handoff.startsWith('-'))
    return { stdout: [], stderr: [USAGE], exitCode: 2 }
  const log = path.join(env.HOME ?? os.homedir(), RELAUNCH_LOG)
  mkdirSync(path.dirname(log), { recursive: true })
  const [command, ...args] = launchArgv(argv)
  const fd = openSync(log, 'a')
  try {
    const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env })
    child.on('error', () => {})
    child.unref()
    if (child.pid === undefined)
      return { stdout: [], stderr: [`${PREFIX}${command} did not start`], exitCode: 1 }
    return { stdout: [String(child.pid), `${PREFIX}pnpm relaunch ${argv.join(' ')} · log ${log}`], stderr: [], exitCode: 0 }
  }
  finally {
    closeSync(fd)
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runRelaunchBg(process.argv.slice(2))
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
