import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { inheritedRunRoot, RunRoot } from './run-root.js'

const PREFIX = '[run-root] '
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
export const SETTLE_MS = 1000

export interface ClosableRoot { readonly path: string, close: () => boolean, exists: () => boolean }

export type Exit = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>

export function survivedTheRun(root: string): string {
  return `${PREFIX}${root} still exists after the run: a temp directory of this run was not removed`
}

export async function inRunRoot(argv: string[], run: Exit, say: (line: string) => void, root: ClosableRoot = RunRoot.open(), settleMs = SETTLE_MS): Promise<number> {
  let exitCode = 1
  try {
    exitCode = await run(argv, process.env)
  }
  finally {
    root.close()
    await sleep(settleMs)
    if (root.exists()) {
      root.close()
      say(survivedTheRun(root.path))
      exitCode = exitCode === 0 ? 1 : exitCode
    }
  }
  return exitCode
}

export async function inOwnOrInheritedRoot(argv: string[], run: Exit, say: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (inheritedRunRoot(env) !== undefined)
    return run(argv, env)
  return inRunRoot(argv, run, say)
}

function runCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env })
    for (const signal of FORWARDED)
      process.on(signal, () => child.kill(signal))
    child.on('error', (error) => {
      process.stderr.write(`${PREFIX}${error.message}\n`)
      resolve(1)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + os.constants.signals[signal])))
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await inOwnOrInheritedRoot(process.argv.slice(2), runCommand, line => process.stderr.write(`${line}\n`))
}
