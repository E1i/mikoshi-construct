import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { CARD_ADMITTED } from '../scripts/core/events.js'
import { busIntakePorts } from '../scripts/intake/intake.js'
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

function assigned(root: string, parking: string, parkingRoot: string, bus?: ReadonlyMap<string, string>): number[] {
  const draft = path.join(root, 'draft.json')
  const card = { name: 'number-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: TASK, witnesses: ['`pnpm run quality` is green'] }
  writeFileSync(draft, JSON.stringify({ cards: [card] }))
  const result = runIntake({ draft, parking, parkingRoot, dir: root, dryRun: true, autoConfirm: true, readStdin: () => '1', taken: '-', cardStates: bus === undefined ? undefined : () => bus })
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

  it('a number the bus holds is not given though the parking lacks it', () => {
    const root = scratch()
    const parkingRoot = park(path.join(root, 'parking'), 10)
    const db = openBus(path.join(root, 'bus.db'))
    try {
      const insert = db.prepare('INSERT INTO events (ts, type, actor, card_id, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?)')
      insert.run('2026-10-24T00:00:00.000Z', CARD_ADMITTED, 'intake:test', 1292, 'admitted-1292', '{}')
      insert.run('2026-10-24T00:00:01.000Z', CARD_ADMITTED, 'intake:test', 1293, 'admitted-1293', '{}')
      expect(assigned(root, parkingRoot, parkingRoot, busIntakePorts(db).cardStates())).toEqual([1294])
    }
    finally {
      db.close()
    }
  })

  it('skips a number the bus holds', () => {
    const root = scratch()
    const parkingRoot = park(path.join(root, 'parking'), 10)
    expect(assigned(root, parkingRoot, parkingRoot, new Map([['40', 'parked']]))).toEqual([41])
  })
})

describe('admittedNumbers', () => {
  it('reads the numbered cards the bus holds and nothing without a bus', () => {
    expect(admittedNumbers(new Map([['12', 'parked'], ['not-a-number', 'running'], ['7', 'merged']]))).toEqual([12, 7])
    expect(admittedNumbers(undefined)).toEqual([])
  })
})
