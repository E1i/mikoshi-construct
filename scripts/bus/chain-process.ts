import type { ChainRow } from './chain.js'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

export type ChainProcess = 'gone' | 'foreign' | 'chain'

export interface ProcessTable {
  commandLine: (pid: number) => string | null
  signalGroup: (leader: number) => void
}

const SHIFT_WORDS = new Set(['shift', 'shift.ts'])

export function namesTheChain(commandLine: string, dir: string): boolean {
  const words = commandLine.split(/\s+/)
  return words.includes(dir) && words.some(word => SHIFT_WORDS.has(word) || word.endsWith('/shift.ts'))
}

export function chainProcess(chain: ChainRow, table: ProcessTable): ChainProcess {
  const commandLine = table.commandLine(chain.leader ?? chain.pid)
  if (commandLine === null)
    return 'gone'
  return chain.leader !== null && namesTheChain(commandLine, chain.dir) ? 'chain' : 'foreign'
}

export function stopChain(chain: ChainRow, table: ProcessTable): void {
  if (chain.state !== 'running')
    return
  const found = chainProcess(chain, table)
  if (found === 'gone')
    return
  if (found === 'foreign')
    throw new Error(chain.leader === null
      ? `the chain in ${chain.dir} recorded no process group (it was not started by pnpm shift:bg): stop it by hand`
      : `PID ${chain.leader} is not the chain in ${chain.dir} (its command line does not name shift and ${chain.dir}): nothing signalled`)
  table.signalGroup(chain.leader!)
}

export function psCommandLine(pid: number): string | null {
  try {
    const line = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return line === '' ? null : line
  }
  catch {
    return null
  }
}

export const REAL_PROCESSES: ProcessTable = {
  commandLine: psCommandLine,
  signalGroup: leader => process.kill(-leader, 'SIGTERM'),
}
