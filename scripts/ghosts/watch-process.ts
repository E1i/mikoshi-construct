import { execFileSync } from 'node:child_process'

export interface ProcessRow {
  pid: number
  args: string
}

export function listProcesses(): ProcessRow[] {
  let output: string
  try {
    output = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
  }
  catch {
    return []
  }

  return output.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map((line) => {
      const spaceIndex = line.indexOf(' ')
      if (spaceIndex === -1)
        return { pid: Number(line), args: '' }
      return { pid: Number(line.slice(0, spaceIndex)), args: line.slice(spaceIndex + 1) }
    })
}

export function isSessionAlive(sessionId: string, processes: ProcessRow[]): boolean {
  const marker = `--session-id ${sessionId}`
  return processes.some(process => process.args.includes(marker))
}
