import type { RoleStop } from '../bus/role.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { RAISED_STATUS, raisedByTheBus } from '../bus/role.js'
import { statusOf } from '../shift/relaunch.js'
import { realRoleStopObserver } from '../shift/role-bus.js'
import { mikoshiHandoff, PREFIX } from './loop.js'

export const FRESH_MS = 2 * 60 * 1000
export const LOOP_SCRIPT = path.join('scripts', 'miko', 'loop.ts')
const CLAUDE = 'claude'
const ARGV_HEAD_NAMING_THE_PROGRAM = 2

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
  handoff?: string
  status?: () => string | null
  raised?: boolean
  observeStop?: (stop: RoleStop) => void
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

export type ExitDecision = { kill: number, line: string, stopped?: true } | { refuse: string }

function freshHandoff(handoffMtime: number | undefined, now: number): boolean {
  return handoffMtime !== undefined && now - handoffMtime <= FRESH_MS
}

export function exitDecision(chain: ProcessRow[], handoffMtime: number | undefined, now: number, status: string | null = null): ExitDecision {
  const at = chain.findIndex(isClaude)
  if (at === -1)
    return { refuse: 'no claude process among the ancestors of this command: nothing to end' }
  const claude = chain[at]!
  const above = chain.slice(at + 1)
  const nextClaude = above.findIndex(isClaude)
  const underLoop = (nextClaude === -1 ? above : above.slice(0, nextClaude)).some(isMikoLoop)
  if (!underLoop && status === RAISED_STATUS && freshHandoff(handoffMtime, now))
    return { kill: claude.pid, line: `ending claude ${claude.pid}: no pnpm miko loop stands above it, so role.stopped goes to the bus for the restart queue`, stopped: true }
  if (!underLoop)
    return { refuse: `claude ${claude.pid} does not run under the pnpm miko loop (${LOOP_SCRIPT}): nothing ended` }
  if (handoffMtime === undefined)
    return { refuse: 'mikoshi.md does not exist: write it with pnpm handoff:write first; nothing ended' }
  const age = now - handoffMtime
  if (age > FRESH_MS)
    return { refuse: `mikoshi.md was written ${Math.round(age / 1000)}s ago, more than ${FRESH_MS / 1000}s: write it with pnpm handoff:write first; nothing ended` }
  return { kill: claude.pid, line: `ending claude ${claude.pid}: the pnpm miko loop starts the next session` }
}

export function runMikoExit(deps: MikoExitDeps): number {
  const decision = exitDecision(ancestors(deps.table(), deps.pid), deps.handoffMtime(), deps.now(), deps.status?.() ?? null)
  if ('refuse' in decision) {
    deps.err(`${PREFIX}${decision.refuse}`)
    return 1
  }
  if (decision.stopped === true)
    deps.observeStop?.({ role: 'miko', handoff: deps.handoff ?? '', status: RAISED_STATUS, reason: 'context', raised: deps.raised ?? false })
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

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const handoff = mikoshiHandoff(os.homedir())
  process.exitCode = runMikoExit({
    pid: process.pid,
    table: () => parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })),
    handoffMtime: () => mtimeOf(handoff),
    now: () => Date.now(),
    kill: pid => process.kill(pid, 'SIGTERM'),
    err: line => console.error(line),
    handoff,
    status: () => existsSync(handoff) ? statusOf(readFileSync(handoff, 'utf8')) : null,
    raised: raisedByTheBus(process.env),
    observeStop: realRoleStopObserver(line => console.error(`${PREFIX}${line}`)),
  })
}
