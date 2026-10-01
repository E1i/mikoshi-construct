import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countLedgerLines, MALFORMED_LEDGER_LINE, readLadderOutcome } from '../../ghosts/ledger.js'

function runsPath(): { dir: string, runs: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-ledger-'))
  mkdirSync(path.join(dir, '.construct'))
  return { dir, runs: path.join(dir, '.construct', 'runs.jsonl') }
}

const ROW = { run: 'run-1', at: '2026-09-27T20:00:00.000Z', task: 'a run', effort: 'low', status: 'done', rung: 'low', attempts: [{ rung: 1, effort: 'low', outcome: 'done', reason: '' }], agents: 3, tokens: 100, toolUses: 4, seconds: 10 }
const row = (fields: Record<string, unknown>): string => JSON.stringify({ ...ROW, ...fields })

describe('countLedgerLines', () => {
  it('is 0 when the ledger is absent', () => {
    const { runs } = runsPath()
    expect(countLedgerLines(runs)).toBe(0)
  })

  it('counts the existing non-empty lines', () => {
    const { runs } = runsPath()
    writeFileSync(runs, '{"a":1}\n{"a":2}\n')
    expect(countLedgerLines(runs)).toBe(2)
  })
})

describe('readLadderOutcome', () => {
  it('is "no ladder run" when there is no new line', () => {
    const { runs } = runsPath()
    writeFileSync(runs, '{"a":1}\n')
    expect(readLadderOutcome(runs, 1)).toEqual({ status: 'no ladder run', run: null, iterations: null })
  })

  it('is "no ladder run" when the ledger is absent', () => {
    const { runs } = runsPath()
    expect(readLadderOutcome(runs, 0)).toEqual({ status: 'no ladder run', run: null, iterations: null })
  })

  it('reads the status, run and attempts length of the last new line', () => {
    const { runs } = runsPath()
    writeFileSync(runs, `${row({ run: 'run-old' })}\n`)
    const before = countLedgerLines(runs)
    const failed = row({ status: 'failed', attempts: [{ rung: 1, effort: 'low', outcome: 'harness failed', reason: 'red' }] })
    const done = row({ attempts: [{ rung: 1, effort: 'low', outcome: 'harness failed', reason: 'red' }, { rung: 2, effort: 'medium', outcome: 'done', reason: '' }] })
    writeFileSync(runs, `${row({ run: 'run-old' })}\n${failed}\n${done}\n`)
    expect(readLadderOutcome(runs, before)).toEqual({ status: 'done', run: 'run-1', iterations: 2 })
  })

  it('carries the args hash the last new line names', () => {
    const { runs } = runsPath()
    writeFileSync(runs, `${row({ argsSha256: 'b'.repeat(64) })}\n`)
    expect(readLadderOutcome(runs, 0)).toEqual({ status: 'done', run: 'run-1', iterations: 1, argsSha256: 'b'.repeat(64) })
  })

  it.each([
    { name: 'a row with a cause on done', text: row({ cause: 'human' }), reason: 'missing or invalid: cause' },
    { name: 'a row of only status and run', text: JSON.stringify({ run: 'run-1', status: 'done' }), reason: 'missing or invalid: at, task, effort, rung, agents, toolUses, seconds, tokens, attempts' },
    { name: 'a last line that is not JSON', text: '{"run":"run-1","sta', reason: 'not JSON' },
    { name: 'a last line that is not a run record', text: '[1]', reason: 'not a run record' },
  ])('reads $name as a malformed ledger line with the reader\'s reason and no run', ({ text, reason }) => {
    const { runs } = runsPath()
    writeFileSync(runs, `${row({ run: 'run-old' })}\n${text}\n`)
    expect(readLadderOutcome(runs, 1)).toEqual({ status: `${MALFORMED_LEDGER_LINE}: ${reason}`, run: null, iterations: null })
  })
})
