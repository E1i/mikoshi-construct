import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runIntake } from '../src/commands/intake/index.js'
import { admittedNumbers } from '../src/commands/intake/numbers.js'

const TASK = 'The intake should assign a number no card already holds.'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-parking-numbers-'))
  roots.push(root)
  return root
}

function park(dir: string, ...ids: number[]): string {
  mkdirSync(dir, { recursive: true })
  for (const id of ids)
    writeFileSync(path.join(dir, `${id}.md`), '')
  return dir
}

function assigned(root: string, parking: string, parkingRoot: string, journalLines: object[] = []): number[] {
  const draft = path.join(root, 'draft.json')
  const card = { name: 'number-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: TASK, witnesses: ['`pnpm run quality` is green'] }
  writeFileSync(draft, JSON.stringify({ cards: [card] }))
  const journal = path.join(root, 'ghosts.jsonl')
  writeFileSync(journal, journalLines.map(line => `${JSON.stringify(line)}\n`).join(''))
  const result = runIntake({ draft, parking, parkingRoot, dir: root, journal, dryRun: true, autoConfirm: true, readStdin: () => '1', taken: '-' })
  if (result.status !== 'dryRun')
    throw new Error(`not a dry run: ${JSON.stringify(result)}`)
  return result.cards.map(card => card.id)
}

describe('construct intake assigns a number no card already holds', () => {
  it('a subdirectory parking skips the numbers of the root parking', () => {
    const root = scratch()
    const parkingRoot = park(path.join(root, 'parking'), 616)
    const sub = park(path.join(parkingRoot, 'after-0.42'), 600)
    expect(assigned(root, sub, parkingRoot)).toEqual([617])
  })

  it('a subdirectory parking skips the numbers of its sibling subdirectories', () => {
    const root = scratch()
    const parkingRoot = park(path.join(root, 'parking'), 3)
    park(path.join(parkingRoot, 'later'), 40)
    const sub = park(path.join(parkingRoot, 'after-0.42'), 5)
    expect(assigned(root, sub, parkingRoot)).toEqual([41])
  })

  it('the root parking skips the numbers of its subdirectories', () => {
    const root = scratch()
    const parkingRoot = park(path.join(root, 'parking'), 3)
    park(path.join(parkingRoot, 'after-0.42'), 50)
    expect(assigned(root, parkingRoot, parkingRoot)).toEqual([51])
  })

  it('a parking outside the root does not read the root', () => {
    const root = scratch()
    const parkingRoot = park(path.join(root, 'parking'), 90)
    const elsewhere = park(path.join(root, 'elsewhere'), 7)
    expect(assigned(root, elsewhere, parkingRoot)).toEqual([8])
  })

  it('skips a number the journal admitted', () => {
    const root = scratch()
    const parkingRoot = park(path.join(root, 'parking'), 10)
    const intake = { event: 'intake', task: '621', card: '#621 moved-card [implement/black-ice/S/cheap/auto] · depends — · blocks —', confirmation: 'auto', corrections: [], bodySha: 'abc', ts: '2026-10-06T00:00:00Z' }
    expect(assigned(root, parkingRoot, parkingRoot, [intake])).toEqual([622])
  })
})

describe('admittedNumbers', () => {
  it('reads the task number of intake lines only', () => {
    const journal = [
      JSON.stringify({ event: 'intake', task: '12' }),
      JSON.stringify({ event: 'path', task: '99' }),
      JSON.stringify({ event: 'intake', task: 'not-a-number' }),
      'not json',
      JSON.stringify({ event: 'intake', task: '7' }),
    ].join('\n')
    expect(admittedNumbers(journal)).toEqual([12, 7])
    expect(admittedNumbers(null)).toEqual([])
  })
})
