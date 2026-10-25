import path from 'node:path'

export interface TreeFile {
  content: string
  mtimeMs: number
}

type JournalChange = { kind: 'write', content: string, at: number } | { kind: 'edit', oldString: string, newString: string, replaceAll: boolean, at: number }

export interface SessionJournal {
  end: number
  changes: ReadonlyMap<string, JournalChange[]>
}

interface ToolUse {
  id: string
  name: string
  input: Record<string, unknown>
}

interface ToolResult {
  failed: boolean
  at: number
}

const JOURNALED_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit'])

const PLAIN_SESSION = /^[\w-]+$/

export function transcriptFile(claudeHome: string, worktree: string, session: string): string | null {
  return PLAIN_SESSION.test(session) ? path.join(claudeHome, 'projects', worktree.replace(/[^a-z0-9]/gi, '-'), `${session}.jsonl`) : null
}

function blocksOf(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = entry.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? message.content.filter(block => block !== null && typeof block === 'object') : []
}

function changeOf(use: ToolUse, at: number): JournalChange | null {
  const { input } = use
  if (use.name === 'Write')
    return typeof input.content === 'string' ? { kind: 'write', content: input.content, at } : null
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string')
    return null
  return { kind: 'edit', oldString: input.old_string, newString: input.new_string, replaceAll: input.replace_all === true, at }
}

export function parseSessionJournal(text: string, worktree: string): SessionJournal {
  const uses: ToolUse[] = []
  const results = new Map<string, ToolResult>()
  let end = Number.NEGATIVE_INFINITY
  for (const line of text.split('\n')) {
    if (line.trim() === '')
      continue
    const entry = JSON.parse(line) as Record<string, unknown>
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    if (!Number.isNaN(at))
      end = Math.max(end, at)
    for (const block of blocksOf(entry)) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && JOURNALED_TOOLS.has(block.name))
        uses.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> })
      if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string' && !Number.isNaN(at))
        results.set(block.tool_use_id, { failed: block.is_error === true, at })
    }
  }
  if (end === Number.NEGATIVE_INFINITY)
    throw new Error('the session journal holds no timestamped entry')
  const changes = new Map<string, JournalChange[]>()
  for (const use of uses) {
    const result = results.get(use.id)
    const file = use.input.file_path
    if (result === undefined || result.failed || typeof file !== 'string')
      continue
    const change = changeOf(use, result.at)
    if (change === null)
      continue
    const relative = path.relative(worktree, path.resolve(worktree, file))
    changes.set(relative, [...(changes.get(relative) ?? []), change])
  }
  return { end, changes }
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

export function journalDoubt(journal: SessionJournal, relative: string, file: TreeFile | null): string | null {
  const changes = journal.changes.get(relative) ?? []
  const last = changes.at(-1)
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
    return 'it changed after the session\'s last Edit of it, by a Bash command or another writer'
  return null
}
