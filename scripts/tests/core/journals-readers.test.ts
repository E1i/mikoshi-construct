import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBoard } from '../../../src/commands/board/index.js'
import { costReport } from '../../../src/commands/cost/index.js'
import { LEDGER_FILE, readLedger } from '../../../src/commands/cost/ledger.js'
import { isolatedCostRoots } from '../../../tests/cost-roots.js'
import { BUS_DB_VARIABLE, openBus } from '../../core/db.js'
import { LADDER_RUN } from '../../core/events.js'
import { importRuns, runEventOf, RUNS_JOURNAL } from '../../intake/import.js'

const NOW = new Date('2026-11-09T10:00:00.000Z')

function run(id: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ run: id, at: '2026-11-09T09:00:00.000Z', task: '#1666 journals-into-the-bus', effort: 'low', status: 'done', rung: 'low', attempts: [{ rung: 1, effort: 'low', outcome: 'passed', reason: '' }], agents: 1, tokens: 100, toolUses: 2, seconds: 60, ...fields })
}

function scratch(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-journals-')))
}

function busWith(lines: string[]): string {
  const file = path.join(scratch(), 'bus.db')
  const db = openBus(file)
  try {
    importRuns(db, `${lines.join('\n')}\n`)
  }
  finally {
    db.close()
  }
  return file
}

function writeRunsFile(dir: string, lines: string[]): void {
  mkdirSync(path.join(dir, '.construct'), { recursive: true })
  writeFileSync(path.join(dir, LEDGER_FILE), `${lines.join('\n')}\n`)
}

function board(dir: string): ReturnType<typeof readBoard> {
  return readBoard(dir, { all: true, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('board and cost read their runs from the bus', () => {
  it('board reads the ladder runs the bus holds, with no runs.jsonl in the repository', () => {
    const bus = busWith([run('wf_one'), run('wf_two')])
    vi.stubEnv(BUS_DB_VARIABLE, bus)
    const reading = board(scratch())
    expect(reading.ledgerPresent).toBe(true)
    expect(reading.ledger.origin).toEqual({ kind: 'bus', file: bus })
    expect(reading.ledger.entries.map(entry => entry.run)).toEqual(['wf_one', 'wf_two'])
  })

  it('cost counts the ladder runs the bus holds, with no runs.jsonl in the repository', () => {
    vi.stubEnv(BUS_DB_VARIABLE, busWith([run('wf_one'), run('wf_two', { status: 'failed', cause: 'task' })]))
    const report = costReport(scratch(), { ...isolatedCostRoots(), env: {} })
    expect(report.ledger).toMatchObject({ runs: 2, failures: 1 })
  })

  it('the bus wins over a runs.jsonl the repository still keeps', () => {
    const dir = scratch()
    writeRunsFile(dir, [run('wf_file')])
    expect(readLedger(dir, busWith([run('wf_bus')])).entries.map(entry => entry.run)).toEqual(['wf_bus'])
  })

  it('a bus with no ladder run leaves the frozen runs.jsonl as the reading', () => {
    const dir = scratch()
    writeRunsFile(dir, [run('wf_file')])
    const reading = readLedger(dir, busWith([]))
    expect(reading.origin).toEqual({ kind: 'file', file: LEDGER_FILE })
    expect(reading.entries.map(entry => entry.run)).toEqual(['wf_file'])
  })

  it('no bus and no runs.jsonl reads as absent', () => {
    const reading = readLedger(scratch(), path.join(scratch(), 'no-bus.db'))
    expect(reading.origin?.kind).toBe('absent')
    expect(board(scratch()).ledgerPresent).toBe(false)
  })
})

describe('the frozen runs.jsonl moves into the bus', () => {
  it('imports each readable line once as a legacy ladder run naming its card', () => {
    const db = openBus(':memory:')
    try {
      const ledger = `${run('wf_one')}\nnot json\n${run('wf_two')}\n`
      expect(importRuns(db, ledger)).toEqual({ imported: 2, present: 0, unreadable: [2] })
      expect(importRuns(db, ledger)).toEqual({ imported: 0, present: 2, unreadable: [2] })
      const rows = db.prepare('SELECT type, card_id, legacy, ts FROM events WHERE type = ? ORDER BY id').all(LADDER_RUN)
      expect(rows).toEqual([
        { type: LADDER_RUN, card_id: 1666, legacy: 1, ts: '2026-11-09T09:00:00.000Z' },
        { type: LADDER_RUN, card_id: 1666, legacy: 1, ts: '2026-11-09T09:00:00.000Z' },
      ])
    }
    finally {
      db.close()
    }
  })

  it('reads the journal the ledger reader names', () => {
    expect(RUNS_JOURNAL).toBe(LEDGER_FILE)
  })

  it('keeps a half record for the ledger reader to report, and refuses a line that is not a JSON object', () => {
    expect(runEventOf(JSON.stringify({ run: 'wf_half' }), 1)?.type).toBe(LADDER_RUN)
    expect(runEventOf('[1]', 2)).toBeNull()
    const dir = scratch()
    writeRunsFile(dir, [])
    const reading = readLedger(dir, busWith([run('wf_one'), JSON.stringify({ run: 'wf_half' })]))
    expect(reading.malformed).toEqual([{ line: 2, reason: expect.stringContaining('missing or invalid') }])
  })
})
