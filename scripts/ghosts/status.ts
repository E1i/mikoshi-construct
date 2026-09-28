import { readFile, rename, writeFile } from 'node:fs/promises'
import process from 'node:process'

export interface WritingRowParams {
  id: string
  worktree: string
  baseSha: string
  start: string
  briefFileName: string
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

export function writingRow(params: WritingRowParams): string {
  return `| ghost-${params.id} | ${params.worktree} | writing | ${params.baseSha} | ${params.start} | /implement ${params.briefFileName}, session ${params.sessionId} | ${params.start} |`
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
  const match = /\bsession (\S+)/.exec(row)
  return match?.[1]
}

let queue: Promise<void> = Promise.resolve()

function withStatusLock<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task)
  queue = result.then(() => undefined, () => undefined)
  return result
}

export async function writeGhostRow(statusPath: string, id: string, row: string): Promise<void> {
  await withStatusLock(async () => {
    const content = await readFile(statusPath, 'utf8')
    const updated = upsertGhostRow(content, id, row)
    const tmpPath = `${statusPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await writeFile(tmpPath, updated)
    await rename(tmpPath, statusPath)
  })
}
