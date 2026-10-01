import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendJournalLine } from '../../ghosts/journal.js'

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
}

describe('appendJournalLine', () => {
  it('creates the journal when absent, with the documented keys', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    const journal = path.join(dir, 'ghosts.jsonl')

    await appendJournalLine(journal, BASE_ENTRY)

    const lines = readFileSync(journal, 'utf8').split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0])
    expect(Object.keys(row).sort()).toEqual(['baseSha', 'class', 'contour', 'duration_ms', 'event', 'exit', 'install', 'iterations', 'ladder', 'num_turns', 'resultLine', 'review', 'run', 'session', 'sketch', 'task', 'total_cost_usd', 'ts', 'usage'].sort())
    expect(row.event).toBe('task')
    expect(row.review).toBeNull()
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  })

  it('carries the sketch sha beside baseSha when the task started from a sketch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    const journal = path.join(dir, 'ghosts.jsonl')
    const sketch = '0123456789abcdef0123456789abcdef01234567'

    await appendJournalLine(journal, { ...BASE_ENTRY, sketch })
    await appendJournalLine(journal, BASE_ENTRY)

    const rows = readFileSync(journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line))
    expect(rows[0].sketch).toBe(sketch)
    expect(rows[0].baseSha).toBe('abc123')
    expect(rows[1].sketch).toBeNull()
  })

  it('appends after the lines the journal already held, byte for byte', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    const journal = path.join(dir, 'ghosts.jsonl')
    const existing = '{"event":"review","task":"g0","verdict":"changes","ts":"2026-09-27T20:00:00.000Z"}\n'
    writeFileSync(journal, existing)

    await appendJournalLine(journal, BASE_ENTRY)

    const content = readFileSync(journal, 'utf8')
    expect(content.startsWith(existing)).toBe(true)
    expect(content.split('\n').filter(line => line !== '')).toHaveLength(2)
  })

  it('serialises concurrent appends without losing either line', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-journal-'))
    const journal = path.join(dir, 'ghosts.jsonl')

    await Promise.all([
      appendJournalLine(journal, { ...BASE_ENTRY, task: 'g1' }),
      appendJournalLine(journal, { ...BASE_ENTRY, task: 'g2' }),
    ])

    const lines = readFileSync(journal, 'utf8').split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(2)
    const tasks = lines.map(line => JSON.parse(line).task).sort()
    expect(tasks).toEqual(['g1', 'g2'])
  })
})
