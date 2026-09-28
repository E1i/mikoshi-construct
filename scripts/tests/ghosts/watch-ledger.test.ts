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
    writeFileSync(runs, `${JSON.stringify({ run: 'run-old', status: 'done' })}\n${JSON.stringify({ run: 'run-g1', status: 'failed' })}\n`)
    expect(readLedgerStage(runs)).toEqual({ kind: 'entry', status: 'failed', run: 'run-g1' })
  })

  it.each([
    { name: 'a half-written last line', tail: '{"run":"run-g2","sta' },
    { name: 'a whitespace-only last line', tail: '   ' },
  ])('reads $name as the ledger still being written', ({ tail }) => {
    const { runs } = runsPath()
    writeFileSync(runs, `${JSON.stringify({ run: 'run-g1', status: 'done' })}\n${tail}`)
    expect(readLedgerStage(runs)).toEqual({ kind: 'writing' })
  })

  it.each([
    { name: 'a half-written line before the last', text: `{"run":"run-g1","sta\n${JSON.stringify({ run: 'run-g2', status: 'done' })}\n`, line: 1 },
    { name: 'a whitespace-only line before the last', text: `   \n${JSON.stringify({ run: 'run-g2', status: 'done' })}\n`, line: 1 },
    { name: 'a last line without status', text: `${JSON.stringify({ run: 'run-g1', status: 'done' })}\n${JSON.stringify({ run: 'run-g2' })}\n`, line: 2 },
    { name: 'a last line without run', text: `${JSON.stringify({ run: 'run-g1', status: 'done' })}\n\n${JSON.stringify({ status: 'done' })}\n`, line: 3 },
  ])('refuses $name, naming the file and the line number', ({ text, line }) => {
    const { runs } = runsPath()
    writeFileSync(runs, text)
    expect(() => readLedgerStage(runs)).toThrow(`${runs} line ${line} `)
  })
})
