import type { ProcessCwds } from '../ports/client/contract.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CLIENT_CWDS_COMMAND, CPU_SAMPLE_COMMAND, OsProcessTable } from '../ports/process-table.js'

export interface SessionLoad {
  sysPercent: number
  syspolicydPercent: number
  fseventsdPercent: number
  nodeProcesses: number
  liveSessions: number
  nodePerSession: number | null
  producedBy: string
}

const SYS_PERCENT = /([\d.]+)% sys/g
const TABLE_HEADER = 'COMMAND'

export const PRODUCED_BY = `${CPU_SAMPLE_COMMAND} (sys and per-process percents, its second sample) and ${CLIENT_CWDS_COMMAND} (a session is a process lsof names claude or a version number, the name the client runs under)`

interface ProcessRow {
  percent: number
  name: string
}

function rowsOfLastSample(top: string): ProcessRow[] {
  const table = top.lastIndexOf(TABLE_HEADER)
  if (table === -1)
    throw new Error(`top printed no ${TABLE_HEADER} table`)
  const rows = top.slice(table).split('\n').slice(1).flatMap((line) => {
    const words = line.trim().split(/\s+/)
    const percent = Number(words.at(-1))
    return words.length < 2 || Number.isNaN(percent) ? [] : [{ percent, name: words.slice(0, -1).join(' ') }]
  })
  if (rows.length === 0)
    throw new Error(`top printed no process row under its ${TABLE_HEADER} table`)
  return rows
}

function percentOf(rows: ProcessRow[], name: string): number {
  return rows.filter(row => row.name === name).reduce((sum, row) => sum + row.percent, 0)
}

function sysPercentOf(top: string): number {
  const last = [...top.matchAll(SYS_PERCENT)].at(-1)
  if (last === undefined)
    throw new Error('top printed no "CPU usage" line with a sys percent')
  return Number(last[1])
}

function sessionsIn(cwds: ProcessCwds): number {
  if (cwds.kind === 'unreadable')
    throw new Error(`lsof could not list the claude processes: ${cwds.why}`)
  return cwds.cwds.length
}

export function readingOf(top: string, cwds: ProcessCwds): SessionLoad {
  const rows = rowsOfLastSample(top)
  const nodeProcesses = rows.filter(row => row.name === 'node').length
  const liveSessions = sessionsIn(cwds)
  return {
    sysPercent: sysPercentOf(top),
    syspolicydPercent: percentOf(rows, 'syspolicyd'),
    fseventsdPercent: percentOf(rows, 'fseventsd'),
    nodeProcesses,
    liveSessions,
    nodePerSession: liveSessions === 0 ? null : nodeProcesses / liveSessions,
    producedBy: PRODUCED_BY,
  }
}

const table = new OsProcessTable()

export function readSessionLoad(top: () => string = () => table.cpuSample(), cwds: () => ProcessCwds = () => table.clientCwds()): SessionLoad {
  return readingOf(top(), cwds())
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(readSessionLoad()))
