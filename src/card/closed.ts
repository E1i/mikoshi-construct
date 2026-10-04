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
