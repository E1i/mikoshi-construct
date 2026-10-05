export function closedTasks(journal: string | null): Map<string, string> {
  return new Map((journal ?? '').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { event?: unknown, task?: unknown, verification?: unknown } | null
      return entry?.event === 'path' && typeof entry.task === 'string' && typeof entry.verification === 'string' ? [[entry.task, entry.verification] as const] : []
    }
    catch {
      return []
    }
  }))
}

export function mergedTasks(journal: string | null): Set<string> {
  return new Set((journal ?? '').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { event?: unknown, task?: unknown, verification?: unknown, report?: unknown, pr?: unknown } | null
      if (typeof entry?.task !== 'string')
        return []
      const merged = entry.event === 'merge'
      const probeClosedByReport = entry.event === 'path' && typeof entry.verification === 'string' && typeof entry.report === 'string' && entry.pr === undefined
      return merged || probeClosedByReport ? [entry.task] : []
    }
    catch {
      return []
    }
  }))
}
