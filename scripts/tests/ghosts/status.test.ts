import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { freeRow, ghostRowState, installFailedOutcome, installUnspawnableOutcome, sessionOutcome, sessionUnspawnableOutcome, upsertGhostRow, writeGhostRow, writingRow } from '../../ghosts/status.js'

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
    const row = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'abc1234', start: '2026-09-27 20:00', briefFileName: 'brief-g1.md', sessionId: 'sess-1' })
    const updated = upsertGhostRow(STATUS, 'g1', row)
    const originalLastRow = '|  C  |   —   | free |  9513121 | —  |   (by A)  window closed;  uneven   spaces | 2026-09-27 19:08 |'
    const insertedAt = updated.indexOf(originalLastRow) + originalLastRow.length + 1
    expect(updated.slice(insertedAt, insertedAt + row.length)).toBe(row)
    expect(updated.replace(`${row}\n`, '')).toBe(STATUS)
  })

  it('replaces the task\'s own existing row as one line, in place', () => {
    const writing = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'abc1234', start: '2026-09-27 20:00', briefFileName: 'brief-g1.md', sessionId: 'sess-1' })
    const withRow = upsertGhostRow(STATUS, 'g1', writing)

    const free = freeRow({ id: 'g1', worktree: '/w/wt-g1', headSha: 'def5678', start: '2026-09-27 20:00', end: '2026-09-27 20:05', outcome: sessionOutcome(0, 'done', '/w/handoff/ghost-g1.jsonl', 'sess-1') })
    const withFreeRow = upsertGhostRow(withRow, 'g1', free)

    expect(withFreeRow.split('\n').filter(line => line.includes('ghost-g1'))).toEqual([free])
    expect(withFreeRow.replace(`${free}\n`, '')).toBe(STATUS)
  })

  it('does not confuse ghost-g1 with ghost-g12', () => {
    const row1 = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', sessionId: 's' })
    const row12 = writingRow({ id: 'g12', worktree: '/w/wt-g12', baseSha: 'a', start: 't', briefFileName: 'b', sessionId: 's' })
    const withBoth = upsertGhostRow(upsertGhostRow(STATUS, 'g1', row1), 'g12', row12)
    const replaced = upsertGhostRow(withBoth, 'g1', 'REPLACED')
    expect(replaced).toContain('REPLACED')
    expect(replaced).toContain(row12)
  })
})

describe('ghostRowState', () => {
  it('reads the state cell of an existing row', () => {
    const row = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', sessionId: 's' })
    const withRow = upsertGhostRow(STATUS, 'g1', row)
    expect(ghostRowState(withRow, 'g1')).toBe('writing')
  })

  it('is undefined when there is no row for the id', () => {
    expect(ghostRowState(STATUS, 'g1')).toBeUndefined()
  })
})

describe('writeGhostRow', () => {
  it('writes through a temporary file and a rename, changing only the ghost row', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-status-'))
    const statusPath = path.join(dir, 'status.md')
    writeFileSync(statusPath, STATUS)

    const writing = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', sessionId: 's' })
    await writeGhostRow(statusPath, 'g1', writing)
    expect(readFileSync(statusPath, 'utf8')).toBe(upsertGhostRow(STATUS, 'g1', writing))

    const free = freeRow({ id: 'g1', worktree: '/w/wt-g1', headSha: 'b', start: 't', end: 't2', outcome: sessionOutcome(0, 'done', '/w/handoff/ghost-g1.jsonl', 's') })
    await writeGhostRow(statusPath, 'g1', free)
    expect(readFileSync(statusPath, 'utf8')).toBe(upsertGhostRow(STATUS, 'g1', free))
  })

  it('serialises concurrent writes to the same file without losing either row', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-status-'))
    const statusPath = path.join(dir, 'status.md')
    writeFileSync(statusPath, STATUS)

    const rowG1 = writingRow({ id: 'g1', worktree: '/w/wt-g1', baseSha: 'a', start: 't', briefFileName: 'b', sessionId: 's' })
    const rowG2 = writingRow({ id: 'g2', worktree: '/w/wt-g2', baseSha: 'a', start: 't', briefFileName: 'b', sessionId: 's' })

    await Promise.all([writeGhostRow(statusPath, 'g1', rowG1), writeGhostRow(statusPath, 'g2', rowG2)])

    const content = readFileSync(statusPath, 'utf8')
    expect(content).toContain(rowG1)
    expect(content).toContain(rowG2)
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
