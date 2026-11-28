import type { ClientProcesses } from '../ports/client/contract.js'
import type { ProcessRow, ProcessSnapshot } from '../ports/process-table.js'

export type SessionMarker = Pick<ClientProcesses, 'sessionMarker'>

export function isSessionAlive(client: SessionMarker, sessionId: string, rows: readonly ProcessRow[]): boolean {
  const marker = client.sessionMarker(sessionId)
  return marker !== null && rows.some(row => row.command.includes(marker))
}

export function processField(client: SessionMarker, sessionId: string | undefined, snapshot: ProcessSnapshot): string {
  if (sessionId === undefined)
    return 'process no session'
  if (!snapshot.readable)
    return `process unknown (the process table could not be read: ${snapshot.reason})`
  return isSessionAlive(client, sessionId, snapshot.rows) ? 'process alive' : 'process dead'
}
