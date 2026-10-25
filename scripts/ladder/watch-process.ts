import { execFileSync } from 'node:child_process'

export interface ProcessRow {
  pid: number
  args: string
}

export type ProcessListing
  = | { readable: true, processes: ProcessRow[] }
    | { readable: false, reason: string }

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0].trim()
}

export function listProcesses(): ProcessListing {
  let output: string
  try {
    output = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  catch (error) {
    return { readable: false, reason: firstLine(error) }
  }

  const processes = output.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map((line) => {
      const spaceIndex = line.indexOf(' ')
      if (spaceIndex === -1)
        return { pid: Number(line), args: '' }
      return { pid: Number(line.slice(0, spaceIndex)), args: line.slice(spaceIndex + 1) }
    })
  return { readable: true, processes }
}

export function isSessionAlive(sessionId: string, processes: ProcessRow[]): boolean {
  const marker = `--session-id ${sessionId}`
  return processes.some(process => process.args.includes(marker))
}

export function processField(sessionId: string | undefined, listing: ProcessListing): string {
  if (sessionId === undefined)
    return 'process no session'
  if (!listing.readable)
    return `process unknown (ps failed: ${listing.reason})`
  return isSessionAlive(sessionId, listing.processes) ? 'process alive' : 'process dead'
}
