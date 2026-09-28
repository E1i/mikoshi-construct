import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countLedgerLines, readLadderOutcome } from '../../ghosts/ledger.js'

function runsPath(): { dir: string, runs: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-ledger-'))
  mkdirSync(path.join(dir, '.construct'))
  return { dir, runs: path.join(dir, '.construct', 'runs.jsonl') }
}

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
    writeFileSync(runs, '{"run":"run-old","status":"done","attempts":[{"outcome":"done"}]}\n')
    const before = countLedgerLines(runs)
    const appended = `${'{"run":"run-1","status":"harness failed","attempts":[{"outcome":"harness failed"}]}'}\n${'{"run":"run-1","status":"done","attempts":[{"outcome":"harness failed"},{"outcome":"done"}]}'}\n`
    writeFileSync(runs, `{"run":"run-old","status":"done","attempts":[{"outcome":"done"}]}\n${appended}`)
    expect(readLadderOutcome(runs, before)).toEqual({ status: 'done', run: 'run-1', iterations: 2 })
  })
})
