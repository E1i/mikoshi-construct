import { describe, expect, it } from 'vitest'
import { journalDoubt, parseSessionJournal, transcriptFile } from '../../nodes/launch/session-journal.js'

const TREE = '/trees/mc-7'
const T0 = Date.parse('2026-10-22T10:00:00.000Z')

function stamp(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

function use(minutes: number, id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', timestamp: stamp(minutes), message: { content: [{ type: 'tool_use', id, name, input }] } })
}

function result(minutes: number, id: string, failed = false): string {
  return JSON.stringify({ type: 'user', timestamp: stamp(minutes), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed }] } })
}

describe('the session journal', () => {
  it('keeps only the Writes and Edits that returned without an error, keyed by their path in the tree', () => {
    const journal = parseSessionJournal([
      use(1, 'a', 'Write', { file_path: `${TREE}/src/a.ts`, content: 'a' }),
      result(1, 'a'),
      use(2, 'b', 'Edit', { file_path: `${TREE}/src/b.ts`, old_string: 'x', new_string: 'y' }),
      result(2, 'b', true),
      use(3, 'c', 'Edit', { file_path: `${TREE}/src/c.ts`, old_string: 'x', new_string: 'y' }),
      use(4, 'd', 'Bash', { command: 'sed -i s/x/y/ src/d.ts' }),
      result(4, 'd'),
      use(5, 'e', 'Write', { file_path: '/elsewhere/e.ts', content: 'e' }),
      result(5, 'e'),
    ].join('\n'), TREE)

    expect([...journal.changes.keys()]).toEqual(['src/a.ts', '../../elsewhere/e.ts'])
    expect(journal.end).toBe(T0 + 5 * 60_000)
  })

  it('refuses a transcript with no timestamped entry and one that is not JSON lines', () => {
    expect(() => parseSessionJournal('', TREE)).toThrow('no timestamped entry')
    expect(() => parseSessionJournal('{"type":', TREE)).toThrow()
  })

  it('replays the Edits after the last Write, replace_all included, and compares the whole content', () => {
    const journal = parseSessionJournal([
      use(1, 'w', 'Write', { file_path: `${TREE}/f.ts`, content: 'x x\nkeep\n' }),
      result(1, 'w'),
      use(2, 'e', 'Edit', { file_path: `${TREE}/f.ts`, old_string: 'x', new_string: '$&y', replace_all: true }),
      result(2, 'e'),
    ].join('\n'), TREE)

    expect(journalDoubt(journal, 'f.ts', { content: '$&y $&y\nkeep\n', mtimeMs: T0 })).toBeNull()
    expect(journalDoubt(journal, 'f.ts', { content: '$&y $&y\nkeep\nmore\n', mtimeMs: T0 })).toBe('its content differs from the session\'s last Write and the Edits after it')
    expect(journalDoubt(journal, 'f.ts', null)).toBe('it is gone or unreadable, and the session journal holds no deletion of it')
  })

  it('holds an Edit-only file to its last new_string and to the time that Edit returned', () => {
    const journal = parseSessionJournal([
      use(1, 'e', 'Edit', { file_path: `${TREE}/g.ts`, old_string: 'a', new_string: 'session text' }),
      result(1, 'e'),
      result(9, 'none'),
    ].join('\n'), TREE)
    const edited = T0 + 60_000

    expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: edited })).toBeNull()
    expect(journalDoubt(journal, 'g.ts', { content: 'other text', mtimeMs: edited })).toBe('its content lacks the session\'s last Edit of it')
    expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: edited + 1 })).toBe('it changed after the session\'s last Edit of it, by a Bash command or another writer')
    expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: T0 + 10 * 60_000 })).toBe('it changed after the session ended')
    expect(journalDoubt(journal, 'h.ts', { content: 'session text', mtimeMs: edited })).toBe('the session journal holds no Write or Edit of it')
  })

  it('finds a transcript under the project directory Claude Code names after the tree, and only for a plain session id', () => {
    expect(transcriptFile('/home/.claude', '/Users/eli/.construct/worktrees/mc-1221', '7d288730-84e9')).toBe('/home/.claude/projects/-Users-eli--construct-worktrees-mc-1221/7d288730-84e9.jsonl')
    expect(transcriptFile('/home/.claude', '/t', '../escape')).toBeNull()
  })
})
