import { createHash } from 'node:crypto'

const PRIORITY_LINE = /^priority:/

export function textSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function headerEndOf(lines: readonly string[]): number {
  const blank = lines.findIndex(line => line.trim() === '')
  return blank === -1 ? lines.length : blank
}

export function priorityLineOf(text: string): string | undefined {
  const lines = text.split('\n')
  return lines.slice(0, headerEndOf(lines)).map(line => line.trim()).find(line => PRIORITY_LINE.test(line))
}

export function withKeptPriority(text: string, latest: string | undefined): string {
  const kept = latest === undefined ? undefined : priorityLineOf(latest)
  if (kept === undefined || priorityLineOf(text) !== undefined)
    return text
  const lines = text.split('\n')
  const at = headerEndOf(lines)
  return [...lines.slice(0, at), kept, ...lines.slice(at)].join('\n')
}
