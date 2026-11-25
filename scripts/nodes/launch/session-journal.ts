import type { CommandJournal as SessionJournal } from '../../ports/client/claude/adapter.js'
import type { JournalChange } from '../../ports/client/contract.js'

export { parseSessionJournal, transcriptFile } from '../../ports/client/claude/adapter.js'
export type { SessionJournal }

export interface TreeFile {
  content: string
  mtimeMs: number
}

const UNICODE_ESCAPE = /\\u([0-9a-f]{4})/gi

export function withEscapesDecoded(text: string): string {
  return text.replace(UNICODE_ESCAPE, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

function replayed(content: string, edits: readonly JournalChange[]): string | null {
  let text = withEscapesDecoded(content)
  for (const edit of edits) {
    if (edit.kind !== 'edit' || edit.oldString === '')
      return null
    const oldText = withEscapesDecoded(edit.oldString)
    const newText = withEscapesDecoded(edit.newString)
    if (!text.includes(oldText))
      return null
    text = edit.replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
  }
  return text
}

export function sessionResult(changes: readonly JournalChange[]): string | null {
  const lastWrite = changes.map(change => change.kind).lastIndexOf('write')
  const written = changes[lastWrite]
  if (written?.kind !== 'write')
    return null
  return replayed(written.content, changes.slice(lastWrite + 1))
}

const IMPORT_START = /^import\b/
const IMPORT_SOURCE = /\bfrom\s*['"]|^import\s*['"]/
const MULTILINE_IMPORT_END = /^\}\s*from\s*['"]/

function importStatementLines(lines: readonly string[]): Set<number> {
  const marked = new Set<number>()
  for (let at = 0; at < lines.length; at++) {
    if (!IMPORT_START.test(lines[at]!))
      continue
    marked.add(at)
    if (IMPORT_SOURCE.test(lines[at]!))
      continue
    while (++at < lines.length) {
      marked.add(at)
      if (MULTILINE_IMPORT_END.test(lines[at]!))
        break
    }
  }
  return marked
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  const sorted = (lines: readonly string[]): string[] => [...lines].sort()
  return sorted(left).join('\n') === sorted(right).join('\n')
}

export function importsReorderedOnly(expected: string, actual: string): boolean {
  const want = expected.split('\n')
  const have = actual.split('\n')
  if (want.length !== have.length)
    return false
  let first = 0
  while (first < want.length && want[first] === have[first])
    first++
  if (first === want.length)
    return true
  let last = want.length - 1
  while (want[last] === have[last])
    last--
  const wantImports = importStatementLines(want)
  const haveImports = importStatementLines(have)
  for (let at = first; at <= last; at++) {
    if (!wantImports.has(at) || !haveImports.has(at))
      return false
  }
  return sameLines(want.slice(first, last + 1), have.slice(first, last + 1))
}

function changedInACommandRun(journal: SessionJournal, mtimeMs: number): boolean {
  return journal.commandRuns.some(run => run.startedAt <= mtimeMs && mtimeMs <= run.endedAt)
}

export function journalDoubt(journal: SessionJournal, relative: string, file: TreeFile | null): string | null {
  const changes = journal.changes.get(relative) ?? []
  const last = changes.at(-1)
  if (file === null && journal.commandRuns.length > 0)
    return null
  if (file !== null && file.mtimeMs > (last?.at ?? Number.NEGATIVE_INFINITY) && changedInACommandRun(journal, file.mtimeMs))
    return null
  if (last === undefined)
    return 'the session journal holds no Write or Edit of it'
  if (file === null)
    return 'it is gone or unreadable, and the session journal holds no deletion of it'
  if (file.mtimeMs > journal.end)
    return 'it changed after the session ended'
  const lastWrite = changes.map(change => change.kind).lastIndexOf('write')
  const written = changes[lastWrite]
  const content = withEscapesDecoded(file.content)
  if (written?.kind === 'write')
    return replayed(written.content, changes.slice(lastWrite + 1)) === content ? null : 'its content differs from the session\'s last Write and the Edits after it'
  if (last.kind !== 'edit' || !content.includes(withEscapesDecoded(last.newString)))
    return 'its content lacks the session\'s last Edit of it'
  if (file.mtimeMs > last.at)
    return 'it changed after the session\'s last Edit of it, outside every command of the session'
  return null
}
