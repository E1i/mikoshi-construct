import type { Expect } from './expect.js'
import type { LadderOutcome } from './ledger.js'
import { appendFile } from 'node:fs/promises'

export interface JournalEntry {
  task: string
  session: string | null
  baseSha: string
  sketch: string | null
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
  agreedSha256: string
  argsSha256: string | null
  expected: Expect | null
  actual: LadderOutcome['actual']
}

let queue: Promise<void> = Promise.resolve()

function withJournalLock<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task)
  queue = result.then(() => undefined, () => undefined)
  return result
}

export async function appendJournalEvent(journalPath: string, event: object): Promise<void> {
  await withJournalLock(async () => {
    await appendFile(journalPath, `${JSON.stringify(event)}\n`)
  })
}

export async function appendJournalLine(journalPath: string, entry: JournalEntry): Promise<void> {
  await appendJournalEvent(journalPath, {
    event: 'task',
    ts: new Date().toISOString(),
    ...entry,
    review: null,
  })
}
