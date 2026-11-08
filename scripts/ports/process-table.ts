import type { ProcessCwds } from './client/contract.js'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { clientAdapter } from './client/index.js'

export const TECHNOLOGY_WORDS = ['lsof', 'ps', 'top'] as const

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  started: string
  command: string
}

export type ProcessSnapshot
  = | { readable: true, rows: readonly ProcessRow[] }
    | { readable: false, reason: string }

export interface ProcessTable {
  snapshot: () => ProcessSnapshot
  clientCwds: () => ProcessCwds
  cpuSample: () => string
}

const LISTING_COLUMNS = ['-Ao', 'pid=,ppid=,pgid=,lstart=,args=']
const LISTING_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s?(.*)$/
const CWD_FIELD = 'n'
const NO_CLIENT_FOUND = 1
const SAMPLE_ARGS = ['-l', '2', '-s', '1', '-n', '1000', '-stats', 'command,cpu']
const SAMPLE_BUFFER = 1 << 26

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.trim()
}

export function parseListing(output: string): ProcessRow[] {
  return output.split('\n').flatMap((line) => {
    const found = LISTING_LINE.exec(line)
    return found === null
      ? []
      : [{ pid: Number(found[1]), ppid: Number(found[2]), pgid: Number(found[3]), started: found[4]!.replace(/\s+/g, ' '), command: found[5]!.trim() }]
  })
}

export function rowOf(snapshot: ProcessSnapshot, pid: number): ProcessRow | null {
  return snapshot.readable ? snapshot.rows.find(row => row.pid === pid) ?? null : null
}

export function rowsOf(snapshot: ProcessSnapshot): readonly ProcessRow[] {
  if (!snapshot.readable)
    throw new Error(`the process table could not be read: ${snapshot.reason}`)
  return snapshot.rows
}

function clientNameArgs(): string[] {
  return clientAdapter().processes.processNames.flatMap(name => ['-c', name])
}

export const CPU_SAMPLE_COMMAND = `top ${SAMPLE_ARGS.join(' ')}`
export const CLIENT_CWDS_COMMAND = `lsof ${clientNameArgs().join(' ')}`

function cwdsIn(output: string): string[] {
  return output.split('\n').filter(line => line.startsWith(CWD_FIELD)).map(line => line.slice(CWD_FIELD.length))
}

export class OsProcessTable implements ProcessTable {
  snapshot(): ProcessSnapshot {
    try {
      return { readable: true, rows: parseListing(execFileSync('ps', LISTING_COLUMNS, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })) }
    }
    catch (error) {
      return { readable: false, reason: firstLine(error) }
    }
  }

  clientCwds(): ProcessCwds {
    try {
      return { kind: 'listed', cwds: cwdsIn(execFileSync('lsof', ['-a', ...clientNameArgs(), '-d', 'cwd', '-F', CWD_FIELD], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
    }
    catch (error) {
      const failed = error as { status?: unknown, stdout?: unknown }
      if (failed.status === NO_CLIENT_FOUND)
        return { kind: 'listed', cwds: cwdsIn(typeof failed.stdout === 'string' ? failed.stdout : '') }
      return { kind: 'unreadable', why: error instanceof Error ? error.message.trim() : String(error) }
    }
  }

  cpuSample(): string {
    return execFileSync('top', SAMPLE_ARGS, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: SAMPLE_BUFFER })
  }
}

export interface InMemoryProcesses {
  rows?: readonly ProcessRow[] | { unreadable: string }
  cwds?: ProcessCwds
  cpu?: string
}

export class InMemoryProcessTable implements ProcessTable {
  constructor(private readonly held: InMemoryProcesses) {}

  snapshot(): ProcessSnapshot {
    const rows = this.held.rows ?? []
    return 'unreadable' in rows ? { readable: false, reason: rows.unreadable } : { readable: true, rows }
  }

  clientCwds(): ProcessCwds {
    return this.held.cwds ?? { kind: 'listed', cwds: [] }
  }

  cpuSample(): string {
    return this.held.cpu ?? ''
  }
}
