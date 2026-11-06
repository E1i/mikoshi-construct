import { describe, expect, it } from 'vitest'
import { journalDoubt, parseSessionJournal, transcriptFile } from '../../nodes/launch/session-journal.js'

const TREE = '/trees/mc-7'
const T0 = Date.parse('2026-10-22T10:00:00.000Z')
const REWRITTEN = { content: 'text the formatter rewrote', mtimeMs: T0 + 5 * 60_000 }

function stamp(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

function use(minutes: number, id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', timestamp: stamp(minutes), message: { content: [{ type: 'tool_use', id, name, input }] } })
}

function result(minutes: number, id: string, failed = false): string {
  return JSON.stringify({ type: 'user', timestamp: stamp(minutes), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed }] } })
}

function editThenRun(input: Record<string, unknown>, failed = false): ReturnType<typeof parseSessionJournal> {
  return parseSessionJournal([
    use(1, 'e', 'Edit', { file_path: `${TREE}/g.ts`, old_string: 'a', new_string: 'session text' }),
    result(1, 'e'),
    use(4, 'b', 'Bash', input),
    result(6, 'b', failed),
  ].join('\n'), TREE)
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
    expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: edited + 1 })).toBe('it changed after the session\'s last Edit of it, outside every command of the session')
    expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: T0 + 10 * 60_000 })).toBe('it changed after the session ended')
    expect(journalDoubt(journal, 'h.ts', { content: 'session text', mtimeMs: edited })).toBe('the session journal holds no Write or Edit of it')
  })

  describe('a unicode escape and the character it names are the same text', () => {
    const DASH = '—'
    const DASH_ESCAPE = '\\u2014'
    const OTHER_DASH_ESCAPE = '\\u2013'
    const EDITED = T0 + 60_000
    const lastEditLost = 'its content lacks the session\'s last Edit of it'
    const lastWriteLost = 'its content differs from the session\'s last Write and the Edits after it'

    function editOf(newString: string): ReturnType<typeof parseSessionJournal> {
      return parseSessionJournal([
        use(1, 'e', 'Edit', { file_path: `${TREE}/g.ts`, old_string: 'a', new_string: newString }),
        result(1, 'e'),
      ].join('\n'), TREE)
    }

    function writeThenEdit(content: string, oldString: string, newString: string): ReturnType<typeof parseSessionJournal> {
      return parseSessionJournal([
        use(1, 'w', 'Write', { file_path: `${TREE}/f.ts`, content }),
        result(1, 'w'),
        use(1, 'e', 'Edit', { file_path: `${TREE}/f.ts`, old_string: oldString, new_string: newString }),
        result(1, 'e'),
      ].join('\n'), TREE)
    }

    function writeOf(content: string): ReturnType<typeof parseSessionJournal> {
      return parseSessionJournal([
        use(1, 'w', 'Write', { file_path: `${TREE}/f.ts`, content }),
        result(1, 'w'),
      ].join('\n'), TREE)
    }

    it('an Edit whose text differs from the file only by a unicode escape raises no doubt', () => {
      expect(journalDoubt(editOf(`x ${DASH} y`), 'g.ts', { content: `head x ${DASH_ESCAPE} y tail`, mtimeMs: EDITED })).toBeNull()
      expect(journalDoubt(editOf(`x ${DASH_ESCAPE} y`), 'g.ts', { content: `head x ${DASH} y tail`, mtimeMs: EDITED })).toBeNull()
    })

    it('an Edit whose text differs from the file by another character behind an escape is still a doubt', () => {
      const journal = editOf(`x ${DASH} y`)

      expect(journalDoubt(journal, 'g.ts', { content: `x ${DASH_ESCAPE} y`, mtimeMs: EDITED })).toBeNull()
      expect(journalDoubt(journal, 'g.ts', { content: `x ${OTHER_DASH_ESCAPE} y`, mtimeMs: EDITED })).toBe(lastEditLost)
      expect(journalDoubt(journal, 'g.ts', { content: 'other text', mtimeMs: EDITED })).toBe(lastEditLost)
    })

    it('a Write whose text differs from the file only by a unicode escape raises no doubt, and another character is a doubt', () => {
      const journal = writeOf(`x ${DASH} y`)

      expect(journalDoubt(journal, 'f.ts', { content: `x ${DASH_ESCAPE} y`, mtimeMs: EDITED })).toBeNull()
      expect(journalDoubt(journal, 'f.ts', { content: `x ${OTHER_DASH_ESCAPE} y`, mtimeMs: EDITED })).toBe(lastWriteLost)
    })

    it('an Edit replayed over a Write finds its old text behind an escape, and not behind another character', () => {
      const replayedOverEscape = writeThenEdit(`x ${DASH_ESCAPE} y`, DASH, 'dash')

      expect(journalDoubt(replayedOverEscape, 'f.ts', { content: 'x dash y', mtimeMs: EDITED })).toBeNull()
      expect(journalDoubt(writeThenEdit(`x ${OTHER_DASH_ESCAPE} y`, DASH, 'dash'), 'f.ts', { content: 'x dash y', mtimeMs: EDITED })).toBe(lastWriteLost)
    })
  })

  it('a file the session edited and its own lint:fix then rewrote raises no doubt', () => {
    for (const command of ['pnpm lint:fix', 'pnpm run lint:fix', `pnpm --dir ${TREE} lint:fix`, `pnpm --dir ${TREE} run lint:fix`, `pnpm --dir ${TREE}/ lint:fix`]) {
      const journal = editThenRun({ command })
      expect(journalDoubt(journal, 'g.ts', REWRITTEN), command).toBeNull()
      expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: T0 + 4 * 60_000 }), command).toBeNull()
      expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: T0 + 6 * 60_000 }), command).toBeNull()
    }

    const written = parseSessionJournal([
      use(1, 'w', 'Write', { file_path: `${TREE}/f.ts`, content: 'as written' }),
      result(1, 'w'),
      use(4, 'b', 'Bash', { command: 'pnpm lint:fix' }),
      result(6, 'b'),
    ].join('\n'), TREE)
    expect(journalDoubt(written, 'f.ts', REWRITTEN)).toBeNull()
  })

  it('a path changed by a command of the session itself is owned by the session', () => {
    for (const command of ['sed -i s/x/y/ g.ts', 'pnpm lint:fix && sed -i s/x/y/ g.ts', 'cp templates/g.ts g.ts', `pnpm --dir ${TREE} run generate`, 'npx eslint --fix g.ts']) {
      const journal = editThenRun({ command })
      expect(journalDoubt(journal, 'g.ts', REWRITTEN), command).toBeNull()
      expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: T0 + 5 * 60_000 }), command).toBeNull()
      expect(journalDoubt(journal, 'copied.ts', REWRITTEN), command).toBeNull()
    }

    const startedAmidTheEdit = parseSessionJournal([
      use(1, 'b', 'Bash', { command: 'pnpm lint:fix' }),
      use(2, 'e', 'Edit', { file_path: `${TREE}/g.ts`, old_string: 'a', new_string: 'session text' }),
      result(3, 'e'),
      result(5, 'b'),
    ].join('\n'), TREE)
    expect(journalDoubt(startedAmidTheEdit, 'g.ts', { content: 'rewritten', mtimeMs: T0 + 4 * 60_000 })).toBeNull()
  })

  it('a path changed outside every command of the session is still a doubt', () => {
    const journal = editThenRun({ command: 'cp templates/g.ts g.ts' })
    const beforeTheRun = T0 + 4 * 60_000 - 1
    const afterTheEnd = T0 + 6 * 60_000 + 1

    for (const mtimeMs of [beforeTheRun, afterTheEnd]) {
      expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs }), String(mtimeMs)).not.toBeNull()
      expect(journalDoubt(journal, 'g.ts', { content: 'other text', mtimeMs }), String(mtimeMs)).not.toBeNull()
      expect(journalDoubt(journal, 'copied.ts', { content: 'other text', mtimeMs }), String(mtimeMs)).not.toBeNull()
    }
    expect(journalDoubt(journal, 'copied.ts', null)).not.toBeNull()
    expect(journalDoubt(journal, 'g.ts', null)).not.toBeNull()
  })

  it('a change outside every command run names what it holds against the file', () => {
    const lastEditMoved = 'it changed after the session\'s last Edit of it, outside every command of the session'
    const lastEditLost = 'its content lacks the session\'s last Edit of it'
    const journal = editThenRun({ command: 'pnpm lint:fix' })

    expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: T0 + 4 * 60_000 - 1 })).toBe(lastEditMoved)
    expect(journalDoubt(journal, 'g.ts', { content: 'session text', mtimeMs: T0 + 6 * 60_000 + 1 })).toBe('it changed after the session ended')
    expect(journalDoubt(journal, 'other.ts', { content: 'other text', mtimeMs: T0 + 2 * 60_000 })).toBe('the session journal holds no Write or Edit of it')
    expect(journalDoubt(journal, 'other.ts', { content: 'other text', mtimeMs: T0 + 6 * 60_000 + 1 })).toBe('the session journal holds no Write or Edit of it')
    expect(journalDoubt(journal, 'g.ts', null)).toBe('it is gone or unreadable, and the session journal holds no deletion of it')

    const laterEntry = parseSessionJournal([
      use(1, 'e', 'Edit', { file_path: `${TREE}/g.ts`, old_string: 'a', new_string: 'session text' }),
      result(1, 'e'),
      use(4, 'b', 'Bash', { command: 'pnpm lint:fix' }),
      result(6, 'b'),
      result(9, 'none'),
    ].join('\n'), TREE)
    expect(journalDoubt(laterEntry, 'g.ts', { content: 'session text', mtimeMs: T0 + 8 * 60_000 })).toBe(lastEditMoved)

    const formatterFirst = parseSessionJournal([
      use(1, 'b', 'Bash', { command: 'pnpm lint:fix' }),
      result(5, 'b'),
      use(6, 'e', 'Edit', { file_path: `${TREE}/g.ts`, old_string: 'a', new_string: 'session text' }),
      result(6, 'e'),
      use(7, 'b2', 'Bash', { command: 'sed -i s/x/y/ g.ts' }),
      result(8, 'b2'),
    ].join('\n'), TREE)
    expect(journalDoubt(formatterFirst, 'g.ts', { content: 'other text', mtimeMs: T0 + 3 * 60_000 })).toBe(lastEditLost)
  })

  it('a command that exited with an error still ran, so what it changed is the session\'s', () => {
    expect(journalDoubt(editThenRun({ command: 'pnpm lint:fix' }, true), 'g.ts', REWRITTEN)).toBeNull()
  })

  it('a command run in the background or never answered has no known run window and owns nothing', () => {
    const lastEditLost = 'its content lacks the session\'s last Edit of it'

    expect(journalDoubt(editThenRun({ command: 'pnpm lint:fix', run_in_background: true }), 'g.ts', REWRITTEN)).toBe(lastEditLost)

    const unanswered = parseSessionJournal([
      use(1, 'e', 'Edit', { file_path: `${TREE}/g.ts`, old_string: 'a', new_string: 'session text' }),
      result(1, 'e'),
      use(4, 'b', 'Bash', { command: 'pnpm lint:fix' }),
      result(6, 'other'),
    ].join('\n'), TREE)
    expect(journalDoubt(unanswered, 'g.ts', REWRITTEN)).toBe(lastEditLost)
  })

  it('finds a transcript under the project directory Claude Code names after the tree, and only for a plain session id', () => {
    expect(transcriptFile('/home/.claude', '/Users/eli/.construct/worktrees/mc-1221', '7d288730-84e9')).toBe('/home/.claude/projects/-Users-eli--construct-worktrees-mc-1221/7d288730-84e9.jsonl')
    expect(transcriptFile('/home/.claude', '/t', '../escape')).toBeNull()
  })
})
