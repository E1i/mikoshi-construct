import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

export interface PnpmResult {
  code: number
  stdout: string
  stderr: string
}

const PNPM_OUTPUT_LIMIT = 64 * 1024 * 1024

export function runPnpmCommand(cwd: string, args: string[], input?: string): PnpmResult {
  const result = spawnSync('pnpm', args, { cwd, input, encoding: 'utf8', maxBuffer: PNPM_OUTPUT_LIMIT })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error === undefined ? result.stderr ?? '' : result.error.message }
}

export function runInstall(cwd: string, logPath: string): Promise<number> {
  const fd = openSync(logPath, 'w')
  let closed = false
  const closeOnce = (): void => {
    if (!closed) {
      closed = true
      closeSync(fd)
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['install', '--frozen-lockfile'], {
      cwd,
      stdio: ['ignore', fd, fd],
    })

    child.on('error', (error) => {
      closeOnce()
      reject(error)
    })

    child.on('close', (code) => {
      closeOnce()
      resolve(code ?? 1)
    })
  })
}
