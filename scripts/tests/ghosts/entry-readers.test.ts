import type { Attempt } from '../../board/handoff.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCheapTasks } from '../../../src/commands/cost/cheap.js'
import { readHandoff } from '../../board/handoff.js'
import { ENTRY_RESULT, entryEvent } from '../../ghosts/entry.js'

const CARD = { id: 7, name: 'n', kind: 'implement', milestone: 'ghosts', size: 'S', contour: 'cheap', decision: 'owner', depends: [], blocks: [], line: 'l' }
const START = { event: 'path', task: '7', path: 'cheap', started: '2026-10-04T08:00:00.000Z', worktree: '/w', branch: 'b', card: CARD, ts: '2026-10-04T08:00:00.000Z' }
const CLOSE = { event: 'path', task: '7', path: 'cheap', pr: 9, verification: 'run', ended: '2026-10-04T09:00:00.000Z', sessions: [{ id: 's', project: '-w' }], ts: '2026-10-04T09:00:00.000Z' }
const ENTRY = entryEvent('7', { CONTRACT: 'c', EXPECT: 'e', ACTION: 'a', RESULT: ENTRY_RESULT }, '2026-10-04T08:00:00.000Z')

function journalDir(lines: object[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'entry-readers-'))
  writeFileSync(path.join(dir, 'ghosts.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return dir
}

describe('the readers of ghosts.jsonl read a journal that holds an entry line as one that does not', () => {
  it('gives the board the same attempts and no warning', () => {
    const without = readHandoff(journalDir([START, CLOSE]))
    const withEntry = readHandoff(journalDir([START, ENTRY, CLOSE]))
    expect(without.attempts).toHaveLength(1)
    const withoutEntryFields = ({ entryLine: _entryLine, journalPath: _journalPath, ...rest }: Attempt): Omit<Attempt, 'entryLine' | 'journalPath'> => rest
    expect(withEntry.attempts.map(withoutEntryFields)).toEqual(without.attempts.map(withoutEntryFields))
    expect(withEntry.attempts[0]!.entryLine).toMatchObject({ CONTRACT: 'c', EXPECT: 'e', ACTION: 'a', RESULT: ENTRY_RESULT })
    expect(without.attempts[0]!.entryLine).toBeUndefined()
    expect(withEntry.warnings).toEqual(without.warnings)
  })

  it('gives construct cost the same window tasks', () => {
    const shiftRoot = path.join(mkdtempSync(path.join(tmpdir(), 'entry-shift-')), 'none')
    const without = readCheapTasks(shiftRoot, path.join(journalDir([START, CLOSE]), 'ghosts.jsonl'))
    const withEntry = readCheapTasks(shiftRoot, path.join(journalDir([START, ENTRY, CLOSE]), 'ghosts.jsonl'))
    expect(withEntry).toEqual(without)
  })
})
