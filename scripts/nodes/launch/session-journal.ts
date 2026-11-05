import type { CommandJournal as SessionJournal } from '../../ports/client/claude/adapter.js'
import type { JournalChange } from '../../ports/client/contract.js'

export { parseSessionJournal, transcriptFile } from '../../ports/client/claude/adapter.js'
export type { SessionJournal }

export interface TreeFile {
  content: string
  mtimeMs: number
}

function replayed(content: string, edits: JournalChange[]): string | null {
  let text = content
  for (const edit of edits) {
    if (edit.kind !== 'edit' || edit.oldString === '' || !text.includes(edit.oldString))
      return null
    text = edit.replaceAll ? text.split(edit.oldString).join(edit.newString) : text.replace(edit.oldString, () => edit.newString)
  }
  return text
}

function changedInACommandRun(journal: SessionJournal, mtimeMs: number): boolean {
  return journal.commandRuns.some(run => run.startedAt <= mtimeMs && mtimeMs <= run.endedAt)
}

export function journalDoubt(journal: SessionJournal, relative: string, file: TreeFile | null): string | null {
  const changes = journal.changes.get(relative) ?? []
  const last = changes.at(-1)
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
  if (written?.kind === 'write')
    return replayed(written.content, changes.slice(lastWrite + 1)) === file.content ? null : 'its content differs from the session\'s last Write and the Edits after it'
  if (last.kind !== 'edit' || !file.content.includes(last.newString))
    return 'its content lacks the session\'s last Edit of it'
  if (file.mtimeMs > last.at)
    return 'it changed after the session\'s last Edit of it, outside every command of the session'
  return null
}
