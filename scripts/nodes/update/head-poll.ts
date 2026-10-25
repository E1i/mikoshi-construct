export type HeadPoll
  = | { kind: 'moved', head: string }
    | { kind: 'still' }
    | { kind: 'unread', error: string }

export interface HeadPollParts {
  from: string
  read: () => string | undefined
  settle: () => void
  reads: number
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

export function pollHead(parts: HeadPollParts): HeadPoll {
  let readOnce = false
  let lastError = ''
  for (let read = 0; read < parts.reads; read += 1) {
    if (read > 0)
      parts.settle()
    try {
      const head = parts.read()
      readOnce = true
      if (head !== undefined && head !== parts.from)
        return { kind: 'moved', head }
    }
    catch (error) {
      lastError = firstLine(error)
    }
  }
  return readOnce ? { kind: 'still' } : { kind: 'unread', error: lastError }
}
