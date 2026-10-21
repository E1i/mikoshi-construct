import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { CARD_STARTED } from '../../core/events.js'
import { runReport } from '../../shift/report.js'
import { ran } from '../core/gh-fake.js'

const HANDOFF = '/handoff'
const SHIFT = '/shift'
const JOURNAL = path.join(HANDOFF, 'ghosts.jsonl')
const CONTRACT = 'implement · cheap · auto · touches scripts/a/**, docs/a.md · law not recorded on the card'
const EXPECT = 'expect tokens ≈ 90k, minutes ≈ 9 — effort low, n=6, median'
const TASK_LINE = {
  event: 'task',
  file: '01.md',
  number: '1',
  task: '1',
  branch: 'feat/1',
  session: 'session-1',
  worktree: null,
  started: '2026-10-05T09:00:00.000Z',
  ended: '2026-10-05T09:02:00.000Z',
  exit: 0,
  signal: null,
}
const V1_ENTRY = {
  event: 'entry',
  task: '1',
  CONTRACT,
  EXPECT,
  ACTION: 'task:start feat/1 #1: cut /tmp/mc-1 from origin/main',
  RESULT: 'accepted · not started',
  ts: '2026-10-05T09:00:00.000Z',
}

function jsonl(lines: object[]): string {
  return lines.map(line => `${JSON.stringify(line)}\n`).join('')
}

function busWithStart(entry: object): string {
  const bus = path.join(mkdtempSync(path.join(tmpdir(), 'report-entry-')), 'bus.db')
  const db = openBus(bus)
  try {
    appendEvent(db, { ts: V1_ENTRY.ts, type: CARD_STARTED, actor: 'worker:start:session-1', cardId: 1, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1:feat/1:${V1_ENTRY.ts}`, payload: { worktree: '/tmp/mc-1', branch: 'feat/1', entry }, legacy: false })
  }
  finally {
    db.close()
  }
  return bus
}

function report(ghosts: object[] | null, bus?: string): string[] {
  const files = new Map<string, string>([[path.join(SHIFT, 'shift.jsonl'), jsonl([TASK_LINE])]])
  if (ghosts !== null)
    files.set(JOURNAL, jsonl(ghosts))
  const out: string[] = []
  const exit = runReport([SHIFT], { cwd: '/', handoffDir: HANDOFF, gh: () => ran('[]'), read: file => files.get(file) ?? null, budget: () => [], ...(bus === undefined ? {} : { bus }), out: line => out.push(line), err: () => {} })
  expect(exit).toBe(0)
  return out
}

describe('shift:report reads CONTRACT and EXPECT from the entry line of ghosts.jsonl', () => {
  it('prints the CONTRACT and the EXPECT of the entry line of the task', () => {
    const rows = report([V1_ENTRY])
    expect(rows).toContain(`CONTRACT | ${CONTRACT}`)
    expect(rows).toContain(`EXPECT   | ${EXPECT}`)
  })

  it('reads the last entry line of the task and ignores that of another task', () => {
    const rows = report([{ ...V1_ENTRY, CONTRACT: 'old' }, V1_ENTRY, { ...V1_ENTRY, task: '2', CONTRACT: 'other' }])
    expect(rows).toContain(`CONTRACT | ${CONTRACT}`)
  })

  it('names the journal and the task when the journal has no entry line for it', () => {
    const rows = report([{ event: 'path', task: '1', path: 'cheap', ts: 'x' }])
    expect(rows).toContain(`CONTRACT | contract not recorded in ${JOURNAL}: no entry line for #1`)
    expect(rows).toContain(`EXPECT   | expect not recorded in ${JOURNAL}: no entry line for #1`)
  })

  it('names the journal and the task when there is no journal at all', () => {
    const rows = report(null)
    expect(rows).toContain(`CONTRACT | contract not recorded in ${JOURNAL}: no entry line for #1`)
  })

  it('reads an entry line without a schema field as it is', () => {
    expect('schema' in V1_ENTRY).toBe(false)
    expect(report([V1_ENTRY])).toContain(`CONTRACT | ${CONTRACT}`)
  })

  it('reads CONTRACT and EXPECT from the card.started of the task in the bus before the journal', () => {
    const bus = busWithStart({ CONTRACT: 'from the bus', EXPECT: 'bus expect', ACTION: 'task:start feat/1 #1', RESULT: 'accepted · not started' })
    const rows = report([V1_ENTRY], bus)
    expect(rows).toContain('CONTRACT | from the bus')
    expect(rows).toContain('EXPECT   | bus expect')
  })

  it('names the bus and the journal when neither holds an entry for the task', () => {
    const bus = busWithStart({})
    const rows = report(null, bus)
    expect(rows).toContain(`CONTRACT | contract not recorded in the bus ${bus} or in ${JOURNAL}: no entry line for #1`)
  })

  it('reads the bus\'s card states, so a card the bus merged with no path line in the journal is closed merged', () => {
    const bus = busWithStart({})
    const db = openBus(bus)
    try {
      db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (1, \'merged\', NULL, 1)').run()
    }
    finally {
      db.close()
    }
    expect(report([V1_ENTRY], bus).find(row => row.startsWith('RESULT'))).toContain(' · closed merged · ')
    expect(report([V1_ENTRY]).find(row => row.startsWith('RESULT'))).toContain(' · not closed · ')
  })
})
