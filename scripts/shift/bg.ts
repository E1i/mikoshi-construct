import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { SHIFT_JOURNAL } from './places.js'

export const PREFIX = '[shift:bg] '
export const USAGE = 'usage: pnpm shift:bg <dir> [shift arguments]'
export const BG_LOG = 'shift-bg.log'

export interface BgResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
}

export function launchArgv(shiftArgs: string[]): string[] {
  return ['nohup', 'pnpm', 'shift', ...shiftArgs]
}

export function runBg(argv: string[], env: NodeJS.ProcessEnv = process.env): BgResult {
  const dir = argv[0]
  if (dir === undefined || dir.startsWith('-'))
    return { stdout: [], stderr: [USAGE], exitCode: 2 }
  if (existsSync(path.join(dir, SHIFT_JOURNAL)))
    return { stdout: [], stderr: [`${PREFIX}${path.join(dir, SHIFT_JOURNAL)} exists — that shift already ran; pnpm shift refuses it`], exitCode: 1 }
  mkdirSync(dir, { recursive: true })
  const log = path.resolve(dir, BG_LOG)
  const [command, ...args] = launchArgv(argv)
  const fd = openSync(log, 'a')
  try {
    const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd], env })
    child.on('error', () => {})
    child.unref()
    if (child.pid === undefined)
      return { stdout: [], stderr: [`${PREFIX}${command} did not start`], exitCode: 1 }
    return { stdout: [String(child.pid), `${PREFIX}pnpm shift ${argv.join(' ')} · log ${log}`], stderr: [], exitCode: 0 }
  }
  finally {
    closeSync(fd)
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runBg(process.argv.slice(2))
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}
