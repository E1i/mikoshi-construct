export const JOURNAL_HISTORY_ENDS = '2026-10-12T17:04:00.000Z'

export const ENDED_IN_BUS: ReadonlySet<string> = new Set(['merged', 'closed'])

export type BusCardStates = ReadonlyMap<string, string>

interface JournalEntry { event?: unknown, task?: unknown, verification?: unknown, report?: unknown, pr?: unknown, ts?: unknown }

export function writtenBeforeHistoryEnds(entry: JournalEntry): boolean {
  const writtenAt = typeof entry.ts === 'string' ? Date.parse(entry.ts) : Number.NaN
  return Number.isNaN(writtenAt) || writtenAt < Date.parse(JOURNAL_HISTORY_ENDS)
}

function historyOf(journal: string | null, bus: BusCardStates | undefined): JournalEntry[] {
  const counted = bus === undefined ? () => true : writtenBeforeHistoryEnds
  return (journal ?? '').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as JournalEntry | null
      return entry !== null && typeof entry === 'object' && counted(entry) ? [entry] : []
    }
    catch {
      return []
    }
  })
}

function endedInBus(bus: BusCardStates | undefined): [string, string][] {
  return [...(bus ?? [])].filter(([, state]) => ENDED_IN_BUS.has(state))
}

export function closedTasks(journal: string | null, bus?: BusCardStates): Map<string, string> {
  const closed = new Map(historyOf(journal, bus).flatMap(entry =>
    entry.event === 'path' && typeof entry.task === 'string' && typeof entry.verification === 'string' ? [[entry.task, entry.verification] as const] : []))
  for (const [task, state] of endedInBus(bus)) {
    if (!closed.has(task))
      closed.set(task, state)
  }
  return closed
}

export function mergedTasks(journal: string | null, bus?: BusCardStates): Set<string> {
  const merged = new Set(historyOf(journal, bus).flatMap((entry) => {
    if (typeof entry.task !== 'string')
      return []
    const mergeLine = entry.event === 'merge'
    const probeClosedByReport = entry.event === 'path' && typeof entry.verification === 'string' && typeof entry.report === 'string' && entry.pr === undefined
    return mergeLine || probeClosedByReport ? [entry.task] : []
  }))
  for (const [task] of endedInBus(bus))
    merged.add(task)
  return merged
}
