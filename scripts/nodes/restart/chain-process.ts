import type { ChainRow, ChainState } from '../../core/chain.js'
import type { ProcessTable as ProcessTablePort } from '../../ports/process-table.js'
import process from 'node:process'
import { OsProcessTable, rowOf } from '../../ports/process-table.js'

export type ChainProcess = 'gone' | 'foreign' | 'live'

export interface ProcessTable {
  commandLine: (pid: number) => string | null
  signalGroup: (leader: number) => void
}

const LIVE_STATES: ReadonlySet<ChainState> = new Set(['running', 'waiting'])

export function namesTheRecord(commandLine: string, token: string): boolean {
  return commandLine.split(/\s+/).includes(token)
}

function processOf(table: ProcessTable, pid: number, token: string): ChainProcess {
  const commandLine = table.commandLine(pid)
  if (commandLine === null)
    return 'gone'
  return namesTheRecord(commandLine, token) ? 'live' : 'foreign'
}

export function chainProcess(chain: ChainRow, table: ProcessTable): ChainProcess {
  if (chain.leader === null)
    return table.commandLine(chain.pid) === null ? 'gone' : 'foreign'
  return processOf(table, chain.leader, chain.dir)
}

export function launchProcess(launch: { pgid: number, session: string }, table: ProcessTable): ChainProcess {
  return processOf(table, launch.pgid, launch.session)
}

export function stopChain(chain: ChainRow, table: ProcessTable): void {
  if (!LIVE_STATES.has(chain.state))
    return
  const found = chainProcess(chain, table)
  if (found === 'gone')
    return
  if (found === 'foreign') {
    throw new Error(chain.leader === null
      ? `the chain in ${chain.dir} recorded no process group: stop it by hand`
      : `PID ${chain.leader} is not the chain in ${chain.dir} (its command line does not name ${chain.dir}): nothing signalled`)
  }
  table.signalGroup(chain.leader!)
}

export function commandLineOf(pid: number, table: ProcessTablePort = new OsProcessTable()): string | null {
  const line = rowOf(table.snapshot(), pid)?.command ?? ''
  return line === '' ? null : line
}

export const REAL_PROCESSES: ProcessTable = {
  commandLine: commandLineOf,
  signalGroup: leader => process.kill(-leader, 'SIGTERM'),
}
