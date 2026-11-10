import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs'

const STAT_INTERVAL_MS = 25

export interface Deadline {
  readonly signal: AbortSignal
  readonly waited: () => number
}

export function deadlineIn(timeoutMs: number): Deadline {
  const started = Date.now()
  return { signal: AbortSignal.timeout(timeoutMs), waited: () => Date.now() - started }
}

function completeLine(file: string): string | undefined {
  if (!existsSync(file))
    return undefined
  const text = readFileSync(file, 'utf8')
  return text.endsWith('\n') && text.trim() !== '' ? text.trim() : undefined
}

export async function settled(file: string, timeoutMs = 20_000, diagnosis: () => string = () => '', deadline: Deadline = deadlineIn(timeoutMs)): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const finish = (): void => {
      unwatchFile(file, changed)
      deadline.signal.removeEventListener('abort', expire)
    }
    const check = (): boolean => {
      const line = completeLine(file)
      if (line === undefined)
        return false
      finish()
      resolve(line)
      return true
    }
    function changed(): void {
      check()
    }
    function expire(): void {
      if (check())
        return
      finish()
      const cause = diagnosis()
      reject(new Error(`${file} did not settle into a complete non-empty line within ${deadline.waited()}ms${cause === '' ? '' : `; ${cause}`}`))
    }
    watchFile(file, { interval: STAT_INTERVAL_MS }, changed)
    deadline.signal.addEventListener('abort', expire)
    if (!check() && deadline.signal.aborted)
      expire()
  })
}
