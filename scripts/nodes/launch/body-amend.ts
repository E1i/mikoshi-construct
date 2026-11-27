export interface BodyAmend { started: string, amended: string }

interface BodyAmendRow { started_text: string, amended_text: string }

const HEADER_PRIORITY = /^priority:/

function withoutHeaderPriority(text: string): string {
  const lines = text.split('\n')
  const blank = lines.findIndex(line => line.trim() === '')
  const headerEnd = blank === -1 ? lines.length : blank
  return lines.filter((line, index) => index >= headerEnd || !HEADER_PRIORITY.test(line.trim())).join('\n')
}

export function onlyThePriorityMoved(row: BodyAmendRow): boolean {
  return withoutHeaderPriority(row.started_text) === withoutHeaderPriority(row.amended_text)
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12)
}
