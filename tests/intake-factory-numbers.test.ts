import type { DatabaseSync } from 'node:sqlite'
import type { GhResponse, GitHub, GitHubPut } from '../scripts/ports/github.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCardEvent } from '../scripts/core/card-bodies.js'
import { openBus } from '../scripts/core/db.js'
import { reduce } from '../scripts/core/reducer.js'
import { busHeldCards, busIntakePorts } from '../scripts/intake/intake.js'
import { RoundLimitRecutter } from '../scripts/nodes/review/pr-close.js'
import { parkingFileText, parseParkingFile } from '../src/card/parking.js'
import { admittedRecord, runIntake } from '../src/commands/intake/index.js'

const A_MAX = 1450
const B_MAX = 29
const B_NEXT = B_MAX + 1
const B_PR = 5
const NOW = new Date('2026-11-04T10:00:00.000Z')
const GOAL_FILE = 'src/commands/board/goal.ts'
const roots: string[] = []
const buses: DatabaseSync[] = []

afterEach(() => {
  for (const db of buses.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number): string {
  return parkingFileText({
    card: `#${id} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`,
    branch: `feat/card-${id}`,
    touches: [GOAL_FILE, 'docs/cli.md'],
    continue: 'stop',
    who: 'shift',
    body: ['Make the plan line right.', '', 'Witnesses:', '- pnpm exec vitest run tests/board.test.ts'].join('\n'),
  })
}

function factoryBus(root: string, name: string, cardId: number): DatabaseSync {
  const db = openBus(path.join(root, name, 'bus.db'))
  buses.push(db)
  const text = cardText(cardId)
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(db, 'worker:intake:test', admittedRecord({ id: cardId, file: `${cardId}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', NOW, null))
  reduce(db)
  return db
}

interface Factories { root: string, parking: string, a: DatabaseSync, b: DatabaseSync }

function twoFactoriesSideBySide(): Factories {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-factory-numbers-'))
  roots.push(root)
  mkdirSync(path.join(root, 'A'))
  mkdirSync(path.join(root, 'B'))
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  writeFileSync(path.join(parking, `${A_MAX}.md`), '')
  return { root, parking, a: factoryBus(root, 'A', A_MAX), b: factoryBus(root, 'B', B_MAX) }
}

function cardsIn(db: DatabaseSync): number[] {
  const rows = db.prepare('SELECT DISTINCT card_id FROM events WHERE card_id IS NOT NULL ORDER BY card_id').all() as { card_id: number }[]
  return rows.map(row => row.card_id)
}

function answered(body: unknown, status = 200): GhResponse {
  return { status, headers: {}, body }
}

describe('a card number comes from the factory it is admitted into', () => {
  it('admit into B takes the max of B plus one', () => {
    const { root, parking, a, b } = twoFactoriesSideBySide()
    const draft = path.join(root, 'draft.json')
    writeFileSync(draft, JSON.stringify({ cards: [{ name: 'number-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: 'The card takes the number of its own factory.', witnesses: ['`pnpm run quality` is green'] }] }))
    const ports = busIntakePorts(b, 'test', () => 1)

    const result = runIntake({ draft, taken: '-', readStdin: () => '1', parking, parkingRoot: parking, dir: root, dryRun: false, autoConfirm: true, events: ports.cardEvents, cardStates: ports.cardStates })

    expect(result).toMatchObject({ status: 'written', cards: [{ id: B_NEXT }] })
    expect(cardsIn(b)).toEqual([B_MAX, B_NEXT])
    expect(cardsIn(a)).toEqual([A_MAX])
  })

  it('recut into B takes the max of B plus one', () => {
    const { a, b } = twoFactoriesSideBySide()
    const head = `feat/card-${B_MAX}`
    const pull = { state: 'open', head: { ref: head }, base: { ref: 'main' }, body: `#${B_MAX} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —` }
    const gitHub: GitHub = endpoint => answered(endpoint.includes('/issues?') ? [{ number: B_PR }] : pull)
    const post: GitHubPut = () => answered({ number: B_PR + 1 }, 201)
    const patch: GitHubPut = () => answered({})
    const recutter = new RoundLimitRecutter({ db: b, gitHub, post, patch, clock: () => NOW, cardStates: () => busHeldCards(b) })

    const outcome = recutter.recut({ cardId: B_MAX, pr: B_PR, head: 'b'.repeat(40), findings: [`${GOAL_FILE}:planLine prints the wrong count`] })

    expect(outcome).toMatchObject({ kind: 'recut', cards: [B_MAX, B_NEXT] })
    expect(cardsIn(b)).toEqual([B_MAX, B_NEXT])
    expect(cardsIn(a)).toEqual([A_MAX])
  })
})
