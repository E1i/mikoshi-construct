import type { WindowSession } from './window-heartbeat.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath } from '../core/db.js'
import { FRESH_MS } from './exit.js'
import { PREV_LABEL, STATE_LABELS } from './handoff-check.js'
import { sessionHandoffOf } from './handoff-write.js'
import { PREFIX } from './loop.js'
import { tabWindowOf } from './tab.js'

export const PRE_COMPACT = 'pre-compact:'
export const NOT_A_TAB = `${PRE_COMPACT} not a tab window; nothing insured`
export const FRESH = `${PRE_COMPACT} the handoff was written within ${FRESH_MS / 1000}s; nothing insured`
export const INSURED = `${PRE_COMPACT} insurance handoff written through pnpm handoff:write`
export const HANDOFF_WRITE_SCRIPT = fileURLToPath(new URL('./handoff-write.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const HANDOFF_WRITE_TIMEOUT_MS = 20_000
const WRITTEN_STOP_HEADING = /^#{1,6} +STOP — (.+), \d{4}-\d{2}-\d{2}, session (\S+), boundary: .*$/
const GENERATED_LABELS = [PREV_LABEL, 'merged today', 'windows', 'stop reason']
const LIST_ENTRY = /^\s*[-*+]\s+#\d+/

export interface HandoffWriteRun {
  status: number | null
  stderr: string
}

export interface PreCompactDeps {
  window: WindowSession | null
  handoff: string | null
  mtime: (file: string) => number | undefined
  now: () => number
  read: (file: string) => string
  stateFromBus: boolean
  handoffWrite: (handoff: string, draft: string) => HandoffWriteRun
  err: (line: string) => void
}

function labelOf(line: string): string | null {
  return /^([a-z][a-z-]*(?: [a-z-]+)*):/i.exec(line.replace(/^[\s*+-]+/, ''))?.[1]?.toLowerCase() ?? null
}

export function insuranceDraftOf(handoff: string, stateFromBus: boolean): string {
  const dropped = new Set([...GENERATED_LABELS, ...(stateFromBus ? STATE_LABELS : [])])
  let inDroppedList = false
  return handoff.split(/\r?\n/).flatMap((line) => {
    const stop = WRITTEN_STOP_HEADING.exec(line)
    if (stop !== null)
      return [`role: ${stop[1]}`, `session: ${stop[2]}`]
    if (inDroppedList && LIST_ENTRY.test(line))
      return []
    const label = labelOf(line)
    inDroppedList = label !== null && dropped.has(label)
    return inDroppedList ? [] : [line]
  }).join('\n')
}

export function runPreCompact(deps: PreCompactDeps): number {
  if (deps.window === null || deps.handoff === null) {
    deps.err(NOT_A_TAB)
    return 0
  }
  const mtime = deps.mtime(deps.handoff)
  if (mtime === undefined) {
    deps.err(`${PRE_COMPACT} no handoff at ${deps.handoff}; nothing to insure from, write it with pnpm handoff:write`)
    return 0
  }
  if (deps.now() - mtime <= FRESH_MS) {
    deps.err(FRESH)
    return 0
  }
  const run = deps.handoffWrite(deps.handoff, insuranceDraftOf(deps.read(deps.handoff), deps.stateFromBus))
  if (run.status === 0) {
    deps.err(`${INSURED}: ${deps.handoff}`)
    return 0
  }
  for (const line of run.stderr.split('\n').filter(Boolean))
    deps.err(line)
  deps.err(`${PRE_COMPACT} the insurance handoff was refused (exit ${run.status ?? 'none'}); ${deps.handoff} is unchanged and older than ${FRESH_MS / 1000}s`)
  return 1
}

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return undefined
  }
}

function handoffWriteOf(env: NodeJS.ProcessEnv): (handoff: string, draft: string) => HandoffWriteRun {
  return (handoff, draft) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pre-compact-'))
    try {
      const file = path.join(dir, 'draft.md')
      writeFileSync(file, draft)
      const run = spawnSync(process.execPath, ['--import', 'tsx', HANDOFF_WRITE_SCRIPT, handoff, file], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: HANDOFF_WRITE_TIMEOUT_MS })
      return { status: run.status, stderr: run.error === undefined ? run.stderr ?? '' : run.error.message }
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function realPreCompactDeps(env: NodeJS.ProcessEnv): PreCompactDeps {
  return {
    window: tabWindowOf(env),
    handoff: sessionHandoffOf(env, os.homedir()),
    mtime: mtimeOf,
    now: () => Date.now(),
    read: file => readFileSync(file, 'utf8'),
    stateFromBus: existsSync(defaultBusPath()),
    handoffWrite: handoffWriteOf(env),
    err: line => console.error(`${PREFIX}${line}`),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runPreCompact(realPreCompactDeps(process.env))
