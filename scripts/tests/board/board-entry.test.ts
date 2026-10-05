import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runBoard } from '../../board/run.js'

const NOW = new Date('2026-10-05T12:00Z')
const CONTRACT = 'implement · cheap · owner · touches scripts/a/**, docs/a.md · law not recorded on the card'
const EXPECT = 'expect tokens ≈ 90k, minutes ≈ 9 — effort low, n=6, median'
const V1_ENTRY = {
  event: 'entry',
  task: 'e-1',
  CONTRACT,
  EXPECT,
  ACTION: 'task:start feat/e-1 #e-1: cut /tmp/mc-e-1 from origin/main',
  RESULT: 'accepted · not started',
  ts: '2026-10-05T09:00:00.000Z',
}
const PATH_LINE = { event: 'path', task: 'e-1', path: 'cheap', reason: 'a script', started: '2026-10-05T09:00:00Z', branch: 'feat/e-1', ts: '2026-10-05T09:00:01.000Z' }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function handoffWith(lines: object[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'board-entry-'))
  roots.push(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'ghosts.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  return dir
}

function card(dir: string): string[] {
  return runBoard(['--dir', dir, 'e-1'], { gh: () => '[]', now: NOW, defaultDir: path.join(dir, 'absent'), colour: false }).stdout
}

describe('board reads CONTRACT and EXPECT of a cheap task from the entry line', () => {
  it('prints the CONTRACT and the EXPECT of the entry line of a cheap task', () => {
    const rows = card(handoffWith([PATH_LINE, V1_ENTRY]))
    expect(rows).toContain(`CONTRACT | ${CONTRACT}`)
    expect(rows).toContain(`EXPECT   | ${EXPECT}`)
  })

  it('reads the last entry line of the task and ignores that of another task', () => {
    const rows = card(handoffWith([PATH_LINE, { ...V1_ENTRY, CONTRACT: 'old' }, V1_ENTRY, { ...V1_ENTRY, task: 'other', CONTRACT: 'other' }]))
    expect(rows).toContain(`CONTRACT | ${CONTRACT}`)
  })

  it('names the journal and the task when a cheap task has no entry line', () => {
    const dir = handoffWith([PATH_LINE])
    const rows = card(dir)
    const journal = path.join(dir, 'ghosts.jsonl')
    expect(rows).toContain(`CONTRACT | contract not recorded in ${journal}: no entry line for #e-1`)
    expect(rows).toContain(`EXPECT   | expect not recorded in ${journal}: no entry line for #e-1`)
  })

  it('reads an entry line without a schema field as it is', () => {
    expect('schema' in V1_ENTRY).toBe(false)
    expect(card(handoffWith([PATH_LINE, V1_ENTRY]))).toContain(`CONTRACT | ${CONTRACT}`)
  })
})
