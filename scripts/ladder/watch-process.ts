import type { ProcessRow, ProcessSnapshot } from '../ports/process-table.js'
import { clientAdapter } from '../ports/client/index.js'

export function sessionInSnapshot(sessionId: string, rows: readonly ProcessRow[]): boolean {
  const marker = clientAdapter().processes.sessionMarker(sessionId)
  return marker !== null && rows.some(row => row.command.includes(marker))
}

export function processField(sessionId: string | undefined, snapshot: ProcessSnapshot): string {
  if (sessionId === undefined)
    return 'process no session'
  if (!snapshot.readable)
    return `process unknown (the process table could not be read: ${snapshot.reason})`
  return sessionInSnapshot(sessionId, snapshot.rows) ? 'process in the table' : 'process not in the table'
}
