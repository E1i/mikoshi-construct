import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { GHOST_ROW } from '../../core/events.js'
import { freeRow, ghostRowSessionId, ghostRowState, ghostRowSupervisor, installFailedOutcome, installUnspawnableOutcome, rowTimestamp, sessionOutcome, sessionUnspawnableOutcome, upsertGhostRow, writeGhostRow, writingRow } from '../../ghosts/status.js'

const STATUS = `# Ghosts — window status

Machine-readable.

| window | tree | state | sha | task start | waits for | updated |
|---|---|---|---|---|---|---|
| A | — | free | bc27f2c | — | window B's ladder | 2026-09-27 21:26 |
|  C  |   —   | free |  9513121 | —  |   (by A)  window closed;  uneven   spaces | 2026-09-27 19:08 |

| policy | value | set by | updated |
|---|---|---|---|
| release-gate | the next release follows the merge of the whole chain | Eli | 2026-09-27 20:41 |
`

describe('upsertGhostRow', () => {
  it('inserts a new row at the end of the window table, leaving everything else byte-identical', () => {
    const row = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'abc1234', start: '2026-09-27 20:00', briefFileName: 'brief-g1.md', supervisorPid: 4242, sessionId: 'sess-1' })
    const updated = upsertGhostRow(STATUS, 'g1', row)
    const originalLastRow = '|  C  |   —   | free |  9513121 | —  |   (by A)  window closed;  uneven   spaces | 2026-09-27 19:08 |'
    const insertedAt = updated.indexOf(originalLastRow) + originalLastRow.length + 1
    expect(updated.slice(insertedAt, insertedAt + row.length)).toBe(row)
    expect(updated.replace(`${row}\n`, '')).toBe(STATUS)
  })

  it('replaces the task\'s own existing row as one line, in place', () => {
    const writing = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'abc1234', start: '2026-09-27 20:00', briefFileName: 'brief-g1.md', supervisorPid: 4242, sessionId: 'sess-1' })
    const withRow = upsertGhostRow(STATUS, 'g1', writing)

    const free = freeRow({ id: 'g1', worktree: '/w/wt-g1', headSha: 'def5678', start: '2026-09-27 20:00', end: '2026-09-27 20:05', outcome: sessionOutcome(0, 'done', '/w/handoff/ghost-g1.jsonl', 'sess-1') })
    const withFreeRow = upsertGhostRow(withRow, 'g1', free)

    expect(withFreeRow.split('\n').filter(line => line.includes('ghost-g1'))).toEqual([free])
    expect(withFreeRow.replace(`${free}\n`, '')).toBe(STATUS)
  })

  it('does not confuse ghost-g1 with ghost-g12', () => {
    const row1 = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', supervisorPid: 4242, sessionId: 's' })
    const row12 = writingRow({ id: 'g12', worktree: '/w/wt-g12', baseSha: 'a', start: 't', briefFileName: 'b', supervisorPid: 4242, sessionId: 's' })
    const withBoth = upsertGhostRow(upsertGhostRow(STATUS, 'g1', row1), 'g12', row12)
    const replaced = upsertGhostRow(withBoth, 'g1', 'REPLACED')
    expect(replaced).toContain('REPLACED')
    expect(replaced).toContain(row12)
  })
})

describe('ghostRowState', () => {
  it('reads the state cell of an existing row', () => {
    const row = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', supervisorPid: 4242, sessionId: 's' })
    const withRow = upsertGhostRow(STATUS, 'g1', row)
    expect(ghostRowState(withRow, 'g1')).toBe('writing')
  })

  it('is undefined when there is no row for the id', () => {
    expect(ghostRowState(STATUS, 'g1')).toBeUndefined()
  })
})

describe('ghostRowSupervisor', () => {
  it('reads the supervisor pid, the sha and the start cells of a writing row', () => {
    const row = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'abc1234', start: '2026-09-27 20:00', briefFileName: 'b', supervisorPid: 4242, sessionId: 's' })
    expect(ghostRowSupervisor(upsertGhostRow(STATUS, 'g1', row), 'g1')).toEqual({ supervisor: 4242, sha: 'abc1234', start: '2026-09-27 20:00' })
  })

  it('is undefined for a row that names no supervisor, and for no row', () => {
    const row = '| ghost-g1 | /w/wt-g1 | writing | abc1234 | 2026-09-27 20:00 | /implement b, session s | 2026-09-27 20:00 |'
    expect(ghostRowSupervisor(upsertGhostRow(STATUS, 'g1', row), 'g1')).toBeUndefined()
    expect(ghostRowSupervisor(STATUS, 'g1')).toBeUndefined()
  })
})

describe('rowTimestamp', () => {
  it('writes the local date and minute with zero padding', () => {
    expect(rowTimestamp(new Date(2026, 0, 2, 3, 4, 59))).toBe('2026-01-02 03:04')
  })
})

describe('ghostRowSessionId', () => {
  it('reads the session id out of a writing row', () => {
    const row = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', supervisorPid: 4242, sessionId: 'sess-1' })
    const withRow = upsertGhostRow(STATUS, 'g1', row)
    expect(ghostRowSessionId(withRow, 'g1')).toBe('sess-1')
  })

  it('reads the session id out of a free row', () => {
    const row = freeRow({ id: 'g1', worktree: '/w/wt-g1', headSha: 'a', start: 't', end: 't2', outcome: sessionOutcome(0, 'done', '/w/handoff/ghost-g1.jsonl', 'sess-1') })
    const withRow = upsertGhostRow(STATUS, 'g1', row)
    expect(ghostRowSessionId(withRow, 'g1')).toBe('sess-1')
  })

  it('reads the id only from the field the launcher writes it in, whatever session words a path or a brief name carries', () => {
    const writing = writingRow({ id: 'g1', worktree: '/w/session wt/g1', baseSha: 'a', start: 't', briefFileName: 'brief session notes.md', supervisorPid: 4242, sessionId: 'sess-1' })
    expect(ghostRowSessionId(upsertGhostRow(STATUS, 'g1', writing), 'g1')).toBe('sess-1')

    const free = freeRow({ id: 'g1', worktree: '/w/session wt/g1', headSha: 'a', start: 't', end: 't2', outcome: sessionOutcome(0, 'done', '/w/session x/ghost-g1.jsonl', 'sess-1') })
    expect(ghostRowSessionId(upsertGhostRow(STATUS, 'g1', free), 'g1')).toBe('sess-1')

    const installFailed = freeRow({ id: 'g1', worktree: '/w/session wt/g1', headSha: 'a', start: 't', end: 't2', outcome: installFailedOutcome(1, '/w/session x/ghost-g1.install.log') })
    expect(ghostRowSessionId(upsertGhostRow(STATUS, 'g1', installFailed), 'g1')).toBeUndefined()
  })

  it('is undefined when there is no row for the id, even though a longer id has one', () => {
    const row12 = writingRow({ id: 'g12', worktree: '/w/wt-g12', baseSha: 'a', start: 't', briefFileName: 'b', supervisorPid: 4242, sessionId: 'sess-12' })
    const withRow = upsertGhostRow(STATUS, 'g12', row12)
    expect(ghostRowSessionId(withRow, 'g1')).toBeUndefined()
    expect(ghostRowSessionId(withRow, 'g12')).toBe('sess-12')
  })
})

const ACTOR = 'worker:ladder:sess-1'
const WRITING = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', supervisorPid: 4242, sessionId: 's' })
const FREE = freeRow({ id: 'g1', worktree: '/w/wt-g1', headSha: 'b', start: 't', end: 't2', outcome: sessionOutcome(0, 'done', '/w/handoff/ghost-g1.jsonl', 's') })

function ghostRowEvents(busPath: string): { card_id: number | null, payload: unknown }[] {
  const db = openBus(busPath)
  try {
    const rows = db.prepare('SELECT card_id, payload FROM events WHERE type = ? ORDER BY id').all(GHOST_ROW) as { card_id: number | null, payload: string }[]
    return rows.map(row => ({ card_id: row.card_id, payload: JSON.parse(row.payload) }))
  }
  finally {
    db.close()
  }
}

describe('writeGhostRow', () => {
  it('writes a bus event, not status.md', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-status-'))
    const busPath = path.join(dir, 'bus.db')

    writeGhostRow(busPath, 1036, 'g1', WRITING, ACTOR)
    writeGhostRow(busPath, 1036, 'g1', FREE, ACTOR)

    expect(ghostRowEvents(busPath)).toEqual([
      { card_id: 1036, payload: { id: 'g1', state: 'writing', row: WRITING } },
      { card_id: 1036, payload: { id: 'g1', state: 'free', row: FREE } },
    ])
    expect(existsSync(path.join(dir, 'status.md'))).toBe(false)
  })

  it('with no status.md in the handoff the row reaches the bus and no file is created', () => {
    const handoff = mkdtempSync(path.join(tmpdir(), 'ghosts-status-'))
    const busPath = path.join(mkdtempSync(path.join(tmpdir(), 'ghosts-bus-')), 'bus.db')

    expect(() => writeGhostRow(busPath, null, 'g1', WRITING, ACTOR)).not.toThrow()

    expect(ghostRowEvents(busPath)).toHaveLength(1)
    expect(readdirSync(handoff)).toEqual([])
  })

  it('throws when the bus cannot be opened', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-status-'))
    const blocker = path.join(dir, 'blocker')
    writeFileSync(blocker, '')

    expect(() => writeGhostRow(path.join(blocker, 'bus.db'), null, 'g1', WRITING, ACTOR)).toThrow()
  })

  it('writing the same row twice yields one event', () => {
    const busPath = path.join(mkdtempSync(path.join(tmpdir(), 'ghosts-bus-')), 'bus.db')

    writeGhostRow(busPath, 1036, 'g1', WRITING, ACTOR)
    writeGhostRow(busPath, 1036, 'g1', WRITING, ACTOR)

    expect(ghostRowEvents(busPath)).toHaveLength(1)
  })
})

describe('sessionOutcome', () => {
  it('says "no ladder run" in place of "ladder <status>" when there is no new line', () => {
    expect(sessionOutcome(0, 'no ladder run', '/w/handoff/ghost-g1.jsonl', 'sess-1'))
      .toBe('exit 0; no ladder run; report /w/handoff/ghost-g1.jsonl; session sess-1')
  })

  it('carries the ladder status otherwise', () => {
    expect(sessionOutcome(3, 'failed', '/w/handoff/ghost-g1.jsonl', 'sess-1'))
      .toBe('exit 3; ladder failed; report /w/handoff/ghost-g1.jsonl; session sess-1')
  })
})

describe('installFailedOutcome', () => {
  it('names the exit code and the log path', () => {
    expect(installFailedOutcome(1, '/w/handoff/ghost-g1.install.log'))
      .toBe('install failed: exit 1; log /w/handoff/ghost-g1.install.log')
  })
})

describe('installUnspawnableOutcome', () => {
  it('names the spawn error message and the log path', () => {
    expect(installUnspawnableOutcome('spawn pnpm ENOENT', '/w/handoff/ghost-g1.install.log'))
      .toBe('install failed: spawn pnpm ENOENT; log /w/handoff/ghost-g1.install.log')
  })
})

describe('sessionUnspawnableOutcome', () => {
  it('names the spawn error message', () => {
    expect(sessionUnspawnableOutcome('spawn claude ENOENT')).toBe('session failed: spawn claude ENOENT')
  })
})
