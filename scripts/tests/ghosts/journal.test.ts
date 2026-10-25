import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { approvalOf, journalEvents, revocationOf, revokeEvent } from '../../ladder/approval.js'
import { ghostLines, ghostLinesText, journalText, recordGhostLine, taskLine } from '../../core/journal.js'
import { ownBusPerTest } from './own-bus.js'

const BASE_ENTRY = {
  task: 'g1',
  session: 'sess-1',
  baseSha: 'abc123',
  sketch: null,
  install: 0,
  exit: 0,
  ladder: 'done',
  run: 'run-1',
  iterations: 1,
  class: null,
  contour: null,
  resultLine: 'present' as const,
  total_cost_usd: 0.5,
  num_turns: 7,
  duration_ms: 1000,
  usage: { input_tokens: 1 },
  agreedSha256: 'a'.repeat(64),
  approvedSha256: 'b'.repeat(64),
  approvedSketch: null,
  rangeDiff: null,
  argsSha256: null,
  expected: { kind: 'forecast' as const, tokens: 166_000, minutes: 12, basis: { effort: 'medium' as const, n: 61 } },
  actual: { tokens: 100, minutes: 10 / 60 },
}

const busOf = ownBusPerTest()

describe('taskLine', () => {
  it('builds the task line with the documented keys', () => {
    const row = taskLine(BASE_ENTRY)
    expect(Object.keys(row).sort()).toEqual(['baseSha', 'class', 'contour', 'duration_ms', 'event', 'exit', 'install', 'iterations', 'ladder', 'num_turns', 'resultLine', 'review', 'run', 'session', 'sketch', 'task', 'total_cost_usd', 'ts', 'usage', 'agreedSha256', 'approvedSha256', 'approvedSketch', 'rangeDiff', 'argsSha256', 'expected', 'actual'].sort())
    expect(row.event).toBe('task')
    expect(row.review).toBeNull()
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  })
})

describe('recordGhostLine', () => {
  it('writes the line to the bus as a ghost.line event and reads it back', () => {
    recordGhostLine('test', taskLine({ ...BASE_ENTRY, sketch: '0123456789abcdef0123456789abcdef01234567' }), busOf())
    recordGhostLine('test', taskLine(BASE_ENTRY), busOf())

    const rows = ghostLines(busOf())
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sketch).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(rows[0]!.baseSha).toBe('abc123')
    expect(rows[1]!.sketch).toBeNull()
  })

  it('keeps the lines in the order they were written', () => {
    recordGhostLine('test', taskLine({ ...BASE_ENTRY, task: 'g1' }), busOf())
    recordGhostLine('test', taskLine({ ...BASE_ENTRY, task: 'g2' }), busOf())

    expect(ghostLines(busOf()).map(line => line.task)).toEqual(['g1', 'g2'])
  })

  it('gives the same text as journalText when there is no legacy file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    recordGhostLine('test', taskLine(BASE_ENTRY), busOf())

    expect(journalText(path.join(dir, 'ghosts.jsonl'), busOf())).toBe(ghostLinesText(busOf()))
  })
})

describe('journalText', () => {
  it('holds the legacy file byte for byte before the lines of the bus', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    const journal = path.join(dir, 'ghosts.jsonl')
    const existing = '{"event":"review","task":"g0","verdict":"changes","ts":"2026-09-27T20:00:00.000Z"}\n'
    writeFileSync(journal, existing)
    recordGhostLine('test', taskLine(BASE_ENTRY), busOf())

    const text = journalText(journal, busOf())
    expect(text.startsWith(existing)).toBe(true)
    expect(text.split('\n').filter(line => line !== '')).toHaveLength(2)
  })

  it('separates a legacy file with no final newline from the lines of the bus', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    const journal = path.join(dir, 'ghosts.jsonl')
    writeFileSync(journal, '{"event":"note","task":"g0"}')
    recordGhostLine('test', taskLine(BASE_ENTRY), busOf())

    expect(journalText(journal, busOf()).split('\n').filter(line => line !== '')).toHaveLength(2)
  })
})

describe('journalEvents over both sources', () => {
  it('a revoke on the bus revokes an approval that only the legacy file holds, for the same card', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    const journal = path.join(dir, 'ghosts.jsonl')
    const sha256 = 'c'.repeat(64)
    writeFileSync(journal, `${JSON.stringify({ event: 'approval', by: 'owner', card: 77, sha256, ts: '2026-10-01T00:00:00.000Z' })}\n`)
    recordGhostLine('test', revokeEvent(sha256, 77, '2026-10-21T00:00:00.000Z'), busOf())

    const events = journalEvents(journal)
    expect(events.map(event => event.event)).toEqual(['approval', 'revoke'])
    expect(approvalOf(events, sha256, 77)).toBeDefined()
    expect(revocationOf(events, sha256, 77)).toBeDefined()
  })
})
