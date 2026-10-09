import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
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

export type ExitDecision = { kill: number, line: string } | { refuse: string }

export function exitDecision(chain: ProcessRow[], handoffMtime: number | undefined, now: number): ExitDecision {
  const at = chain.findIndex(isClaude)
  if (at === -1)
    return { refuse: 'no claude process among the ancestors of this command: nothing to end' }
  const claude = chain[at]!
  const above = chain.slice(at + 1)
  const nextClaude = above.findIndex(isClaude)
  const underLoop = (nextClaude === -1 ? above : above.slice(0, nextClaude)).some(isMikoLoop)
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
  const decision = exitDecision(ancestors(deps.table(), deps.pid), deps.handoffMtime(), deps.now())
  if ('refuse' in decision) {
    deps.err(`${PREFIX}${decision.refuse}`)
    return 1
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

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const handoff = mikoshiHandoff(os.homedir())
  process.exitCode = runMikoExit({
    pid: process.pid,
    table: () => parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })),
    handoffMtime: () => mtimeOf(handoff),
    now: () => Date.now(),
    kill: pid => process.kill(pid, 'SIGTERM'),
    err: line => console.error(line),
  })
}
