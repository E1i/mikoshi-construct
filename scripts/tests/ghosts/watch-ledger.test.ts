import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLedgerStage } from '../../ghosts/watch-ledger.js'

function runsPath(): { dir: string, runs: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-watch-ledger-'))
  mkdirSync(path.join(dir, '.construct'))
  return { dir, runs: path.join(dir, '.construct', 'runs.jsonl') }
}

const ROW = { at: '2026-09-27T20:00:00.000Z', task: 'a run', effort: 'low', status: 'done', rung: 'low', attempts: [{ rung: 1, effort: 'low', outcome: 'done', reason: '' }], agents: 3, tokens: 100, toolUses: 4, seconds: 10 }
const row = (fields: Record<string, unknown>): string => JSON.stringify({ ...ROW, ...fields })

describe('readLedgerStage', () => {
  it('is null when the ledger is absent', () => {
    const { runs } = runsPath()
    expect(readLedgerStage(runs)).toBeNull()
  })

  it('is null when the ledger has no non-empty line', () => {
    const { runs } = runsPath()
    writeFileSync(runs, '\n')
    expect(readLedgerStage(runs)).toBeNull()
  })

  it('reads the status and run of the last non-empty line', () => {
    const { runs } = runsPath()
    writeFileSync(runs, `${row({ run: 'run-old' })}\n${row({ run: 'run-g1', status: 'failed' })}\n`)
    expect(readLedgerStage(runs)).toEqual({ kind: 'entry', status: 'failed', run: 'run-g1' })
  })

  it.each([
    { name: 'a half-written last line', tail: '{"run":"run-g2","sta' },
    { name: 'a whitespace-only last line', tail: '   ' },
  ])('reads $name as the ledger still being written', ({ tail }) => {
    const { runs } = runsPath()
    writeFileSync(runs, `${row({ run: 'run-g1' })}\n${tail}`)
    expect(readLedgerStage(runs)).toEqual({ kind: 'writing' })
  })

  it.each([
    { name: 'a half-written line before the last', text: `{"run":"run-g1","sta\n${row({ run: 'run-g2' })}\n`, line: 1 },
    { name: 'a whitespace-only line before the last', text: `   \n${row({ run: 'run-g2' })}\n`, line: 1 },
    { name: 'a last line without status', text: `${row({ run: 'run-g1' })}\n${JSON.stringify({ run: 'run-g2' })}\n`, line: 2 },
    { name: 'a last line without run', text: `${row({ run: 'run-g1' })}\n\n${row({ run: undefined })}\n`, line: 3 },
    { name: 'a last line with a cause on done', text: `${row({ run: 'run-g1' })}\n${row({ run: 'run-g2', cause: 'human' })}\n`, line: 2 },
    { name: 'a last line of only status and run', text: `${row({ run: 'run-g1' })}\n${JSON.stringify({ run: 'run-g2', status: 'done' })}\n`, line: 2 },
  ])('refuses $name, naming the file, the line number and the schema', ({ text, line }) => {
    const { runs } = runsPath()
    writeFileSync(runs, text)
    expect(() => readLedgerStage(runs)).toThrow(`${runs} line ${line} is not a ledger row by contract/contours/ledger-row.schema.json (`)
  })
})
