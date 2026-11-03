import type { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { MERGE_DONE } from '../core/events.js'
import { PREFIX } from './bg.js'

export const SNAPSHOT_MS = 5 * 60_000
export const SQLITE_SHELL = 'sqlite3'
const SHELL_LIMIT_MS = 5 * 60_000
const UNPUBLISHED = '.publishing'
const SHELL_QUOTE = '\''
const INTEGRITY_OK = 'ok'
const MISSING_PROGRAM = 'ENOENT'
const EVENTS_READ = 'PRAGMA integrity_check; SELECT count(*) FROM events NOT INDEXED;'
const LAST_MERGE = `SELECT coalesce(max(id), 0) AS id FROM events WHERE type = '${MERGE_DONE}'`

const execShell = promisify(execFile)

function isMissingProgram(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === MISSING_PROGRAM
}

async function runShell(args: readonly string[], shell: string): Promise<string> {
  try {
    const { stdout } = await execShell(shell, ['-bail', '-cmd', `.timeout ${BUSY_TIMEOUT_MS}`, ...args], { timeout: SHELL_LIMIT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
    return stdout
  }
  catch (error) {
    if (isMissingProgram(error))
      throw new Error(`${shell} is not on PATH; the bus reaches the sqlite backup API through the sqlite3 command-line shell, so install it to take backups and snapshots`)
    throw error
  }
}

export async function backupInto(source: string, file: string, shell: string = SQLITE_SHELL): Promise<void> {
  if (file.includes(SHELL_QUOTE))
    throw new Error(`a backup target with a quote in its path is refused: ${file}`)
  mkdirSync(path.dirname(file), { recursive: true })
  await runShell([source, `.backup ${SHELL_QUOTE}${file}${SHELL_QUOTE}`], shell)
}

export async function unreadableReason(file: string, shell: string = SQLITE_SHELL): Promise<string | null> {
  let lines: string[]
  try {
    lines = (await runShell([file, EVENTS_READ], shell)).trim().split(/\r?\n/)
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (lines[0] !== INTEGRITY_OK || lines.length !== 2 || !/^\d+$/.test(lines[1] ?? ''))
    return `integrity_check and the whole events read gave: ${lines.join(' | ').slice(0, 300)}`
  return null
}

export async function publishSnapshot(busPath: string, file: string, shell: string = SQLITE_SHELL): Promise<void> {
  const publishing = `${file}${UNPUBLISHED}`
  rmSync(publishing, { force: true })
  try {
    await backupInto(busPath, publishing, shell)
    const reason = await unreadableReason(publishing, shell)
    if (reason !== null)
      throw new Error(`the copy failed its gate, so the last good snapshot is kept: ${reason}`)
    renameSync(publishing, file)
  }
  finally {
    rmSync(publishing, { force: true })
  }
}

export interface SnapshotParts {
  db: DatabaseSync
  busPath: string
  file: string
  now: () => number
  paused?: () => boolean
}

function lastMerge(db: DatabaseSync): number {
  return Number((db.prepare(LAST_MERGE).get() as { id: number }).id)
}

export class BusSnapshot {
  private publishedAt = Number.NEGATIVE_INFINITY
  private mergeSeen = 0
  private inFlight: Promise<void> | null = null
  private finished: string[] = []

  constructor(private readonly parts: SnapshotParts) {}

  step(): string[] {
    const lines = this.finished.splice(0)
    if (this.inFlight !== null || this.parts.paused?.() === true)
      return lines
    try {
      const merge = lastMerge(this.parts.db)
      const nowMs = this.parts.now()
      const onTimer = nowMs - this.publishedAt >= SNAPSHOT_MS
      if (!onTimer && merge <= this.mergeSeen)
        return lines
      this.publishedAt = nowMs
      this.mergeSeen = merge
      this.start(onTimer ? 'on its timer' : 'after a merge')
    }
    catch (error) {
      lines.push(this.failed(error))
    }
    return lines
  }

  async settled(): Promise<void> {
    await this.inFlight
  }

  private start(why: string): void {
    const { busPath, file } = this.parts
    this.inFlight = (async () => {
      try {
        await publishSnapshot(busPath, file)
        this.finished.push(`${PREFIX}published the bus snapshot ${file} through the sqlite backup API ${why}; external tools read it, never the live bus`)
      }
      catch (error) {
        this.finished.push(this.failed(error))
      }
      finally {
        this.inFlight = null
      }
    })()
  }

  private failed(error: unknown): string {
    return `${PREFIX}publishing the bus snapshot ${this.parts.file} failed: ${error instanceof Error ? error.message : String(error)}; retried when the next snapshot is due`
  }
}
