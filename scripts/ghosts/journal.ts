import { appendFile } from 'node:fs/promises'

export interface JournalEntry {
  task: string
  session: string | null
  baseSha: string
  install: number | null
  exit: number | null
  ladder: string
  run: string | null
  iterations: number | null
  class: string | null
  contour: unknown | null
  resultLine: 'present' | 'missing'
  total_cost_usd: number | null
  num_turns: number | null
  duration_ms: number | null
  usage: unknown | null
}

let queue: Promise<void> = Promise.resolve()

function withJournalLock<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task)
  queue = result.then(() => undefined, () => undefined)
  return result
}

export async function appendJournalLine(journalPath: string, entry: JournalEntry): Promise<void> {
  await withJournalLock(async () => {
    const line = JSON.stringify({
      event: 'task',
      ts: new Date().toISOString(),
      ...entry,
      review: null,
    })
    await appendFile(journalPath, `${line}\n`)
  })
}
