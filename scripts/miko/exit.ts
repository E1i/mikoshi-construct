import type { RoleStop, THRESHOLDS, WindowEnd } from '../bus/role.js'
import type { ExitLine, ExitReadings, Reading } from './eddies-measure.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath } from '../bus/db.js'
import { RAISED_STATUS, raisedByTheBus } from '../bus/role.js'
import { statusOf } from '../shift/relaunch.js'
import { realRoleStopObserver } from '../shift/role-bus.js'
import { appendExitLine, exitLineOf, projectRoot, realExitReadings, SESSION_EXIT_EVENT, UNKNOWN } from './eddies-measure.js'
import { MIKO_HANDOFF_NAME, mikoHandoff, PREFIX } from './loop.js'
import { windowEndObserver } from './role-end.js'

export const FRESH_MS = 2 * 60 * 1000
export const LOOP_SCRIPT = path.join('scripts', 'miko', 'loop.ts')
export const NOT_AT_A_STOP_CONDITION = 'not at a stop condition: wait with pnpm miko:watch --once --card <N> or take the next card'
const CLAUDE = 'claude'
const ARGV_HEAD_NAMING_THE_PROGRAM = 2

export type StopReason = typeof THRESHOLDS[number] | 'done'

export interface ProcessRow {
  pid: number
  ppid: number
  args: string
}

export interface MikoExitDeps {
  pid: number
  table: () => ProcessRow[]
  handoffMtime: () => number | undefined
  now: () => number
  kill: (pid: number) => void
  err: (line: string) => void
  readings: () => ExitReadings
  recordExit: (line: ExitLine) => void
  handoff?: string
  status?: () => string | null
  raised?: boolean
  observeStop?: (stop: RoleStop) => void
  endWindow?: (end: WindowEnd) => void
}

export function parsePs(text: string): ProcessRow[] {
  return text.split('\n').flatMap((line) => {
    const [pid, ppid, ...args] = line.trim().split(/\s+/)
    return /^\d+$/.test(pid ?? '') && /^\d+$/.test(ppid ?? '') ? [{ pid: Number(pid), ppid: Number(ppid), args: args.join(' ') }] : []
  })
}

export function ancestors(table: ProcessRow[], pid: number): ProcessRow[] {
  const byPid = new Map(table.map(row => [row.pid, row]))
  const chain: ProcessRow[] = []
  const seen = new Set<number>()
  let row = byPid.get(pid)
  while (row !== undefined && !seen.has(row.pid)) {
    seen.add(row.pid)
    chain.push(row)
    row = byPid.get(row.ppid)
  }
  return chain.slice(1)
}

export function isClaude(row: ProcessRow): boolean {
  return row.args.split(/\s+/).slice(0, ARGV_HEAD_NAMING_THE_PROGRAM).some(word => path.basename(word) === CLAUDE)
}

export function isMikoLoop(row: ProcessRow): boolean {
  return row.args.includes(LOOP_SCRIPT)
}

function atOrAbove(value: Reading<number>, limit: Reading<number>): boolean {
  return value !== UNKNOWN && limit !== UNKNOWN && value >= limit
}

export function stopReasonOf(status: string | null, readings: ExitReadings): StopReason | null {
  if (status === 'DONE')
    return 'done'
  if (readings.context === UNKNOWN || atOrAbove(readings.context, readings.contextWarn))
    return 'context'
  if (atOrAbove(readings.spent, readings.spendWarn))
    return 'spend'
  return null
}

export type ExitDecision = { kill: number, line: string, reason: StopReason, stopped?: true } | { refuse: string }

function freshHandoff(handoffMtime: number | undefined, now: number): boolean {
  return handoffMtime !== undefined && now - handoffMtime <= FRESH_MS
}

export function exitDecision(chain: ProcessRow[], handoffMtime: number | undefined, now: number, status: string | null, readings: ExitReadings): ExitDecision {
  const at = chain.findIndex(isClaude)
  if (at === -1)
    return { refuse: 'no claude process among the ancestors of this command: nothing to end' }
  const claude = chain[at]!
  const reason = stopReasonOf(status, readings)
  if (reason === null)
    return { refuse: `${NOT_AT_A_STOP_CONDITION}; nothing ended` }
  if (reason === 'done')
    return { kill: claude.pid, reason, line: `ending claude ${claude.pid}: ${MIKO_HANDOFF_NAME} says STATUS: ${status}` }
  const above = chain.slice(at + 1)
  const nextClaude = above.findIndex(isClaude)
  const underLoop = (nextClaude === -1 ? above : above.slice(0, nextClaude)).some(isMikoLoop)
  if (!underLoop && status === RAISED_STATUS && freshHandoff(handoffMtime, now))
    return { kill: claude.pid, reason, line: `ending claude ${claude.pid} at the ${reason} limit: no pnpm miko loop stands above it, so role.stopped goes to the bus for the restart queue`, stopped: true }
  if (!underLoop)
    return { refuse: `claude ${claude.pid} does not run under the pnpm miko loop (${LOOP_SCRIPT}): nothing ended` }
  if (handoffMtime === undefined)
    return { refuse: `${MIKO_HANDOFF_NAME} does not exist: write it with pnpm handoff:write first; nothing ended` }
  const age = now - handoffMtime
  if (age > FRESH_MS)
    return { refuse: `${MIKO_HANDOFF_NAME} was written ${Math.round(age / 1000)}s ago, more than ${FRESH_MS / 1000}s: write it with pnpm handoff:write first; nothing ended` }
  return { kill: claude.pid, reason, line: `ending claude ${claude.pid} at the ${reason} limit: the pnpm miko loop starts the next session` }
}

export function runMikoExit(deps: MikoExitDeps): number {
  const readings = deps.readings()
  const status = deps.status?.() ?? null
  const decision = exitDecision(ancestors(deps.table(), deps.pid), deps.handoffMtime(), deps.now(), status, readings)
  if ('refuse' in decision) {
    deps.err(`${PREFIX}${decision.refuse}`)
    return 1
  }
  if (decision.reason === 'done')
    deps.endWindow?.('miko:exit')
  if (decision.stopped === true) {
    deps.endWindow?.('eddies')
    deps.observeStop?.({ role: 'miko', handoff: deps.handoff ?? '', status: RAISED_STATUS, reason: decision.reason, raised: deps.raised ?? false })
  }
  try {
    deps.recordExit(exitLineOf(readings, decision.reason, new Date(deps.now()).toISOString()))
  }
  catch (error) {
    deps.err(`${PREFIX}the ${SESSION_EXIT_EVENT} line was not written (${error instanceof Error ? error.message : String(error)})`)
  }
  deps.err(`${PREFIX}${decision.line}`)
  deps.kill(decision.kill)
  return 0
}

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return undefined
  }
}

export function realMikoExitDeps(handoff: string): MikoExitDeps {
  const root = projectRoot(process.env)
  return {
    pid: process.pid,
    table: () => parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })),
    handoffMtime: () => mtimeOf(handoff),
    now: () => Date.now(),
    kill: pid => process.kill(pid, 'SIGTERM'),
    err: line => console.error(line),
    readings: () => realExitReadings(process.env, os.homedir(), root, defaultBusPath()),
    recordExit: line => appendExitLine(root, line),
    handoff,
    status: () => existsSync(handoff) ? statusOf(readFileSync(handoff, 'utf8')) : null,
    raised: raisedByTheBus(process.env),
    observeStop: realRoleStopObserver(line => console.error(`${PREFIX}${line}`)),
    endWindow: windowEndObserver({ busPath: defaultBusPath(), pid: process.pid, now: () => new Date(), err: line => console.error(`${PREFIX}${line}`) }),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runMikoExit(realMikoExitDeps(mikoHandoff(os.homedir())))
