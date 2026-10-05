import type { Signal } from '../../src/ui/signal.js'
import { SIGNAL_FIELDS } from '../../src/ui/signal.js'

export const ENTRY_EVENT = 'entry'
export const ENTRY_SCHEMA = 2
export const ENTRY_RESULT = 'accepted · not started'

export function entryEvent(task: string, signal: Signal, at: string): object {
  return { event: ENTRY_EVENT, task, ...signal, ts: at }
}

export function entryLine(task: string, signal: Signal, at: string): string {
  return `${JSON.stringify({ ...entryEvent(task, signal, at), schema: ENTRY_SCHEMA })}\n`
}

function isSignal(entry: Record<string, unknown>): entry is Signal & Record<string, unknown> {
  return SIGNAL_FIELDS.every(field => typeof entry[field] === 'string')
}

export function entryOf(journal: string, id: string): Signal | undefined {
  return journal.split('\n').flatMap((text) => {
    try {
      const entry = JSON.parse(text) as Record<string, unknown> | null
      return entry?.event === ENTRY_EVENT && entry.task === id && isSignal(entry) ? [entry] : []
    }
    catch {
      return []
    }
  }).at(-1)
}
