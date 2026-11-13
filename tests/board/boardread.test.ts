import type { DatabaseSync } from 'node:sqlite'
import type { BusFacts } from '../../src/commands/board/bus.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { currentLane, openOwnerWaits } from '../../scripts/core/bus-readings.js'
import { closeOwnerWait, openBus, openOwnerWait } from '../../scripts/core/db.js'
import { reduce } from '../../scripts/core/reducer.js'
import { busCardEvents } from '../../scripts/intake/intake.js'
import { busProjections } from '../../scripts/supervisor/composition.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { withReadOnlyBus } from '../../src/commands/cost/bus.js'
import { runAdmit } from '../../src/commands/intake/admit.js'
import { runMove } from '../../src/commands/intake/move.js'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const ADMITTED_LANE = 'lane-window'
const LANES = 3
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-boardread-'))
  roots.push(root)
  return root
}

function factsOf(file: string): BusFacts {
  const reading = busReaderAt(file, () => NOW)()
  if (reading.status !== 'read')
    throw new Error(`the bus was ${reading.status}`)
  return reading.facts
}

function parkedCard(parking: string, card: number, touch: string): string {
  const file = path.join(parking, ADMITTED_LANE, `${card}.md`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `card: #${card} slice-${card} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/slice-${card}\ntouches: ${touch}\ncontinue: stop\nwho: shift\n\nDo slice ${card}.\n`)
  return file
}

function withBus<T>(use: (db: DatabaseSync, file: string) => T): T {
  const file = path.join(scratch(), 'bus.db')
  const db = openBus(file)
  try {
    return use(db, file)
  }
  finally {
    db.close()
  }
}

function openTwoWaits(db: DatabaseSync): [string, string] {
  const ts = NOW.toISOString()
  const first = openOwnerWait(db, ts, 'policy', { need: 'decision', text: 'which path for #1500?', card: 1500, request: 1 })
  const second = openOwnerWait(db, ts, 'policy', { need: 'command', text: 'run the release check', command: 'pnpm release:verify', request: 2 })
  reduce(db, 'pending', busProjections())
  return [first, second]
}

describe('the board reads the bus through the bus readers', () => {
  it('for every card in the bus the board lane is currentLane', () => {
    const root = scratch()
    const parking = path.join(root, 'parking')
    const repo = path.join(root, 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    const cards = [1501, 1502, 1503, 1504]
    for (const card of cards)
      writeFileSync(path.join(repo, 'src', `${card}.ts`), '')
    withBus((db, file) => {
      const events = busCardEvents(db, 'by-hand', () => LANES)
      for (const card of cards)
        expect(runAdmit({ file: parkedCard(parking, card, `src/${card}.ts`), dir: repo, dryRun: false, autoConfirm: true, parkingRoot: parking, events }, () => NOW).status).toBe('admitted')
      expect(runMove({ move: '#1504', to: 'lane-2', draft: undefined, taken: undefined, admit: undefined, parking, events }, () => NOW).status).toBe('moved')
      reduce(db, 'pending', busProjections())
      const board = factsOf(file).cards
      const bus = withReadOnlyBus(file, read => cards.map(card => [card, currentLane(read, card)]))
      expect(board.map(card => [card.id, card.lane])).toEqual(bus)
      expect(board.every(card => card.lane !== null && card.lane !== ADMITTED_LANE)).toBe(true)
    })
  })

  it('the board open waits are the bus open waits', () => {
    withBus((db, file) => {
      const [first, second] = openTwoWaits(db)
      closeOwnerWait(db, NOW.toISOString(), 'owner', first, 'the first path', 3)
      reduce(db, 'pending', busProjections())
      const bus = withReadOnlyBus(file, openOwnerWaits)
      expect(bus.map(wait => wait.id)).toEqual([second])
      expect(factsOf(file).waits).toEqual(bus)
    })
  })

  it('a wait closed by owner.wait.closed and not reduced yet leaves the last reduced waits marked behind, and is gone once reduced', () => {
    withBus((db, file) => {
      const [first, second] = openTwoWaits(db)
      expect(factsOf(file).waits.map(wait => wait.id)).toEqual([first, second])
      expect(closeOwnerWait(db, NOW.toISOString(), 'owner', first, 'the first path', 3)).toBe(true)
      expect(factsOf(file)).toMatchObject({ waits: [{ id: second }], waitsStale: expect.stringMatching(/^owner_waits shows the last reduced list, behind by \d+ events and 0 s: reduced through event \d+, behind owner\.wait\.closed \d+$/) })
      reduce(db, 'pending', busProjections())
      expect(factsOf(file).waits.map(wait => wait.id)).toEqual([second])
    })
  })
})
