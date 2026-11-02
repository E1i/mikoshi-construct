import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { MERGE_DONE } from '../core/events.js'
import { PREFIX } from './bg.js'

export const SNAPSHOT_MS = 5 * 60_000
export const SQLITE_SHELL = 'sqlite3'
const BACKUP_LIMIT_MS = 5 * 60_000
const UNPUBLISHED = '.publishing'
const SHELL_QUOTE = '\''
const LAST_MERGE = `SELECT coalesce(max(id), 0) AS id FROM events WHERE type = '${MERGE_DONE}'`

export function backupInto(source: string, file: string): void {
  if (file.includes(SHELL_QUOTE))
    throw new Error(`a backup target with a quote in its path is refused: ${file}`)
  mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(SQLITE_SHELL, ['-bail', '-cmd', `.timeout ${BUSY_TIMEOUT_MS}`, source, `.backup ${SHELL_QUOTE}${file}${SHELL_QUOTE}`], { stdio: 'pipe', timeout: BACKUP_LIMIT_MS, killSignal: 'SIGKILL' })
}

export function publishSnapshot(busPath: string, file: string): void {
  const publishing = `${file}${UNPUBLISHED}`
  rmSync(publishing, { force: true })
  backupInto(busPath, publishing)
  renameSync(publishing, file)
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

  constructor(private readonly parts: SnapshotParts) {}

  step(): string[] {
    if (this.parts.paused?.() === true)
      return []
    try {
      const merge = lastMerge(this.parts.db)
      const nowMs = this.parts.now()
      const onTimer = nowMs - this.publishedAt >= SNAPSHOT_MS
      if (!onTimer && merge <= this.mergeSeen)
        return []
      publishSnapshot(this.parts.busPath, this.parts.file)
      this.publishedAt = nowMs
      this.mergeSeen = merge
      return [`${PREFIX}published the bus snapshot ${this.parts.file} through the sqlite backup API ${onTimer ? 'on its timer' : 'after a merge'}; external tools read it, never the live bus`]
    }
    catch (error) {
      return [`${PREFIX}publishing the bus snapshot ${this.parts.file} failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }
}
