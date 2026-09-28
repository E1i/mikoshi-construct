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
    expect(readLedgerStage(runs)).toEqual({ status: 'failed', run: 'run-g1' })
  })
})
