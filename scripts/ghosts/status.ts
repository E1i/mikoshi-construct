import { createHash } from 'node:crypto'
import { appendEvent, openBus } from '../bus/db.js'
import { GHOST_ROW } from '../core/events.js'

export interface WritingRowParams {
  id: string
  worktree: string
  baseSha: string
  start: string
  briefFileName: string
  supervisorPid: number
  sessionId: string
}

export interface FreeRowParams {
  id: string
  worktree: string
  headSha: string
  start: string
  end: string
  outcome: string
}

export interface GhostRowSupervisor {
  supervisor: number
  sha: string
  start: string
}

const SUPERVISOR_NAMED = /, supervisor (\d+), /

export function rowTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function writingRow(params: WritingRowParams): string {
  return `| ghost-${params.id} | ${params.worktree} | writing | ${params.baseSha} | ${params.start} | /implement ${params.briefFileName}, supervisor ${params.supervisorPid}, session ${params.sessionId} | ${params.start} |`
}

export function freeRow(params: FreeRowParams): string {
  return `| ghost-${params.id} | ${params.worktree} | free | ${params.headSha} | ${params.start} | ${params.outcome} | ${params.end} |`
}

export function sessionOutcome(exitCode: number, ladderStatus: string, reportPath: string, sessionId: string): string {
  const ladderText = ladderStatus === 'no ladder run' ? 'no ladder run' : `ladder ${ladderStatus}`
  return `exit ${exitCode}; ${ladderText}; report ${reportPath}; session ${sessionId}`
}

export function installFailedOutcome(exitCode: number, logPath: string): string {
  return `install failed: exit ${exitCode}; log ${logPath}`
}

export function installUnspawnableOutcome(message: string, logPath: string): string {
  return `install failed: ${message}; log ${logPath}`
}

export function sessionUnspawnableOutcome(message: string): string {
  return `session failed: ${message}`
}

function ghostRowMarker(id: string): string {
  return `| ghost-${id} |`
}

function windowTableBounds(lines: string[]): { header: number, end: number } {
  const header = lines.findIndex(line => line.startsWith('| window |'))
  if (header === -1)
    throw new Error('status.md has no window table (no line starting with "| window |")')
  let end = header + 1
  while (end < lines.length && lines[end].startsWith('|'))
    end += 1
  return { header, end }
}

export function upsertGhostRow(statusText: string, id: string, row: string): string {
  const lines = statusText.split('\n')
  const { header, end } = windowTableBounds(lines)
  const marker = ghostRowMarker(id)

  for (let index = header; index < end; index += 1) {
    if (lines[index].startsWith(marker)) {
      lines[index] = row
      return lines.join('\n')
    }
  }

  lines.splice(end, 0, row)
  return lines.join('\n')
}

export function ghostRowState(statusText: string, id: string): string | undefined {
  const marker = ghostRowMarker(id)
  const row = statusText.split('\n').find(line => line.startsWith(marker))
  if (row === undefined)
    return undefined
  const cells = row.split('|').map(cell => cell.trim())
  return cells[3]
}

export function ghostRowSessionId(statusText: string, id: string): string | undefined {
  const marker = ghostRowMarker(id)
  const row = statusText.split('\n').find(line => line.startsWith(marker))
  if (row === undefined)
    return undefined
  const cells = row.split('|').map(cell => cell.trim())
  const match = /(?:, |; )session (\S+)$/.exec(cells[6] ?? '')
  return match?.[1]
}

export function ghostRowSupervisor(statusText: string, id: string): GhostRowSupervisor | undefined {
  const marker = ghostRowMarker(id)
  const row = statusText.split('\n').find(line => line.startsWith(marker))
  if (row === undefined)
    return undefined
  const cells = row.split('|').map(cell => cell.trim())
  const named = SUPERVISOR_NAMED.exec(cells[6] ?? '')
  return named === null ? undefined : { supervisor: Number(named[1]), sha: cells[4], start: cells[5] }
}

export function writeGhostRow(busPath: string, cardId: number | null, id: string, row: string, actor: string): void {
  const db = openBus(busPath)
  try {
    appendEvent(db, {
      ts: new Date().toISOString(),
      type: GHOST_ROW,
      actor,
      cardId,
      pr: null,
      head: null,
      dedupeKey: `${GHOST_ROW}:${id}:${createHash('sha256').update(row).digest('hex')}`,
      payload: { id, state: ghostRowState(row, id), row },
      legacy: false,
    })
  }
  finally {
    db.close()
  }
}
