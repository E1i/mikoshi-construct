import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

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
