import { appendFileSync } from 'node:fs'

export function appendJournalLine(journalPath: string, line: string): void {
  appendFileSync(journalPath, `${line}\n`)
}
