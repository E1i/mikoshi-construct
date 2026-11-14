import { spawn } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'

export interface AnswerRun {
  cwd: string
  command: string
  argv: string[]
  stdoutPath: string
  stderrPath: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  onLine?: (line: string) => void
  started?: (pid: number) => void
}

export function spawnClient(run: AnswerRun): Promise<number> {
  const outFd = openSync(run.stdoutPath, 'w')
  const errFd = openSync(run.stderrPath, 'w')
  let closed = false
  let partial = ''
  const closeOnce = (): void => {
    if (!closed) {
      closed = true
      if (partial !== '')
        run.onLine?.(partial)
      closeSync(outFd)
      closeSync(errFd)
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(run.command, run.argv, { cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', errFd], signal: run.signal })
    if (child.pid !== undefined)
      run.started?.(child.pid)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (closed)
        return
      writeSync(outFd, chunk)
      const lines = `${partial}${chunk}`.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines)
        run.onLine?.(line)
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
