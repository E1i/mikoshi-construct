import type { ChildProcess } from 'node:child_process'
import type { TraceLine } from './sandbox-refusals.js'
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { expect } from 'vitest'
import { SANDBOX_TRACE_VARIABLE } from './sandbox-refusals.js'

const TRACE_FILE_VARIABLE = 'SANDBOX_TRACE_FILE'
const TRACE_TEST_VARIABLE = 'SANDBOX_TRACE_TEST'
const CHILD_PRELOAD = path.join(import.meta.dirname, 'sandbox-trace-child.mjs')
const REFUSED_LINE = /^.*(?:EPERM|operation not permitted).*$/gim

function current(): { file: string, test: string } {
  const { testPath, currentTestName } = expect.getState()
  return { file: testPath ?? '', test: currentTestName ?? '' }
}

function record(text: unknown, at = current()): void {
  const trace = process.env[SANDBOX_TRACE_VARIABLE]
  const lines = String(text ?? '').match(REFUSED_LINE)
  if (trace === undefined || lines === null)
    return
  for (const refused of new Set(lines))
    appendFileSync(trace, `${JSON.stringify({ ...at, refused: refused.trim() } satisfies TraceLine)}\n`)
}

function isOptions(arg: unknown): arg is { env?: NodeJS.ProcessEnv } {
  return arg !== null && typeof arg === 'object' && !Array.isArray(arg)
}

function tagged(args: unknown[], takesArgv: boolean): unknown[] {
  const at = current()
  const index = args.findIndex((arg, position) => position > 0 && isOptions(arg))
  const options = index === -1 ? {} : args[index] as { env?: NodeJS.ProcessEnv }
  const env = { ...(options.env ?? process.env), [TRACE_FILE_VARIABLE]: at.file, [TRACE_TEST_VARIABLE]: at.test }
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${CHILD_PRELOAD}`.trim()
  const next = [...args]
  if (index !== -1) {
    next[index] = { ...options, env }
    return next
  }
  const callback = typeof next.at(-1) === 'function' ? next.splice(-1) : []
  const argv = takesArgv && next.length === 1 ? [[]] : []
  return [...next, ...argv, { env }, ...callback]
}

function watched(child: ChildProcess): ChildProcess {
  const at = current()
  child.stderr?.on('data', (chunk: unknown) => record(chunk, at))
  child.on('error', error => record(error, at))
  return child
}

function rethrown(error: unknown): never {
  record(error instanceof Error ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}` : error)
  throw error
}

type Spawning = (...args: unknown[]) => unknown

const original = { ...childProcess } as unknown as Record<string, Spawning>
const patched = childProcess as unknown as Record<string, Spawning>

const TAKES_ARGV: Record<string, boolean> = { spawn: true, execFile: true, exec: false, spawnSync: true, execFileSync: true, execSync: false }

for (const name of ['spawn', 'execFile', 'exec'])
  patched[name] = (...args) => watched(original[name]!(...tagged(args, TAKES_ARGV[name]!)) as ChildProcess)
patched.spawnSync = (...args) => {
  const result = original.spawnSync!(...tagged(args, true)) as { stderr?: unknown, error?: unknown }
  record(`${String(result.stderr ?? '')}\n${String(result.error ?? '')}`)
  return result
}
for (const name of ['execFileSync', 'execSync']) {
  patched[name] = (...args) => {
    try {
      return original[name]!(...tagged(args, TAKES_ARGV[name]!))
    }
    catch (error) {
      return rethrown(error)
    }
  }
}
syncBuiltinESMExports()
