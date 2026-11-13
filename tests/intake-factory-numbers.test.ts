import type { DatabaseSync } from 'node:sqlite'
import type { GhResponse, GitHub, GitHubPut } from '../scripts/ports/github.js'
import type { RequestTools } from '../scripts/window/window-requests.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCardEvent } from '../scripts/core/card-bodies.js'
import { openBus } from '../scripts/core/db.js'
import { reduce } from '../scripts/core/reducer.js'
import { busHeldCards, busIntakePorts } from '../scripts/intake/intake.js'
import { RoundLimitRecutter } from '../scripts/nodes/review/pr-close.js'
import { busProjections } from '../scripts/supervisor/composition.js'
import { requestFromWindow, runRequest, WindowRequests } from '../scripts/window/window-requests.js'
import { parkingFileText, parseParkingFile } from '../src/card/parking.js'
import { admittedRecord, runIntake } from '../src/commands/intake/index.js'
import { nextCardNumbers } from '../src/commands/intake/numbers.js'

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

function admitInto(db: DatabaseSync, cardId: number): void {
  const text = cardText(cardId)
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(db, 'worker:intake:test', admittedRecord({ id: cardId, file: `${cardId}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', NOW, null))
  reduce(db, 'pending', busProjections())
}

function factoryBus(root: string, name: string, cardId: number): DatabaseSync {
  const db = openBus(path.join(root, name, 'bus.db'))
  buses.push(db)
  admitInto(db, cardId)
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

function notWired(): never {
  throw new Error('recording foreign numbers needs no other tool')
}

const NO_TOOLS: RequestTools = { treeOf: notWired, exists: notWired, cutTree: notWired, dryRunOf: notWired, addDecision: notWired, causeHolds: notWired, closePr: notWired, closeDropped: () => [] }

function requests(db: DatabaseSync): WindowRequests {
  return new WindowRequests(db, () => NOW, NO_TOOLS)
}

function recordForeign(db: DatabaseSync, ids: readonly number[]): void {
  expect(runRequest(['numbers.foreign', '--ids', ids.join(',')], db, NOW, 'test', () => {})).toBe(0)
  expect(requests(db).run()).toMatchObject([{ kind: 'done' }])
  reduce(db, 'pending', busProjections())
}

function eventsOfType(db: DatabaseSync, type: string): { actor: string, payload: string }[] {
  return db.prepare('SELECT actor, payload FROM events WHERE type = ?').all(type) as { actor: string, payload: string }[]
}

interface OneFactory { root: string, parking: string, db: DatabaseSync }

function busWithForeignRow(ids: readonly number[]): OneFactory {
  const { root, parking, b } = twoFactoriesSideBySide()
  for (const id of ids)
    admitInto(b, id)
  return { root, parking, db: b }
}

function admittedFrom(factory: OneFactory, taken: string): unknown {
  const draft = path.join(factory.root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards: [{ name: 'number-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: 'The card takes the number of its own row.', witnesses: ['`pnpm run quality` is green'] }] }))
  const ports = busIntakePorts(factory.db, 'test', () => 1)
  return runIntake({ draft, taken: '-', readStdin: () => taken, parking: factory.parking, parkingRoot: factory.parking, dir: factory.root, dryRun: false, autoConfirm: true, events: ports.cardEvents, cardStates: ports.cardStates })
}

const FOREIGN_ROW = [1451, 1452, 1453, 1454, 1455, 1456, 1457, 1458, 1459]
const OWN_MAX_OUTSIDE = 31
const OWN_NEXT = OWN_MAX_OUTSIDE + 1

describe('a recorded foreign id does not move the row of the factory', () => {
  it('a bus with a recorded foreign high id gives the next card in its own row', () => {
    const factory = busWithForeignRow(FOREIGN_ROW)
    recordForeign(factory.db, FOREIGN_ROW)

    expect(admittedFrom(factory, String(OWN_MAX_OUTSIDE))).toMatchObject({ status: 'written', cards: [{ id: OWN_NEXT }] })
  })

  it('a bus with no record keeps following its highest id', () => {
    const factory = busWithForeignRow(FOREIGN_ROW)

    expect(admittedFrom(factory, String(OWN_MAX_OUTSIDE))).toMatchObject({ status: 'written', cards: [{ id: FOREIGN_ROW.at(-1)! + 1 }] })
  })

  it('a recut in a bus with a recorded foreign high id takes the next number of its own row', () => {
    const { db } = busWithForeignRow(FOREIGN_ROW)
    recordForeign(db, FOREIGN_ROW)
    const pull = { state: 'open', head: { ref: `feat/card-${B_MAX}` }, base: { ref: 'main' }, body: `#${B_MAX} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —` }
    const gitHub: GitHub = endpoint => answered(endpoint.includes('/issues?') ? [{ number: OWN_MAX_OUTSIDE }] : pull)
    const recutter = new RoundLimitRecutter({ db, gitHub, post: () => answered({ number: OWN_NEXT + 1 }, 201), patch: () => answered({}), clock: () => NOW, cardStates: () => busHeldCards(db) })

    const outcome = recutter.recut({ cardId: B_MAX, pr: B_PR, head: 'b'.repeat(40), findings: [`${GOAL_FILE}:planLine prints the wrong count`] })

    expect(outcome).toMatchObject({ kind: 'recut', cards: [B_MAX, OWN_NEXT] })
  })

  it('the own row skips a number a recorded foreign card holds', () => {
    const factory = busWithForeignRow([OWN_NEXT, ...FOREIGN_ROW])
    recordForeign(factory.db, [OWN_NEXT, ...FOREIGN_ROW])

    expect(admittedFrom(factory, String(OWN_MAX_OUTSIDE))).toMatchObject({ status: 'written', cards: [{ id: OWN_NEXT + 1 }] })
  })

  it('a run of numbers clears a recorded foreign card whole, because a recut counts up from its first', () => {
    const { db } = busWithForeignRow([OWN_NEXT + 1])
    recordForeign(db, [OWN_NEXT + 1])

    expect(nextCardNumbers(busHeldCards(db), [OWN_MAX_OUTSIDE], 2)).toEqual([OWN_NEXT + 2, OWN_NEXT + 3])
  })

  it('a recorded card stays in the bus with its state', () => {
    const { db } = busWithForeignRow(FOREIGN_ROW)
    const before = new Map(busHeldCards(db))

    recordForeign(db, FOREIGN_ROW)

    expect(new Map(busHeldCards(db))).toEqual(before)
  })

  it('the request writes one event under the name of the window that asked', () => {
    const { db } = busWithForeignRow(FOREIGN_ROW)

    recordForeign(db, FOREIGN_ROW)

    expect(eventsOfType(db, 'numbers.foreign').map(event => ({ actor: event.actor, ids: (JSON.parse(event.payload) as { ids: number[] }).ids }))).toEqual([{ actor: 'worker:window:test', ids: FOREIGN_ROW }])
  })

  it.each([[[]], [['--ids']], [['--ids', 'abc']], [['--ids', '0,1451']]])('the command with %j prints the usage and writes nothing', (flags) => {
    const { db } = busWithForeignRow(FOREIGN_ROW)

    expect(runRequest(['numbers.foreign', ...flags], db, NOW, 'test', () => {})).toBe(2)
    expect(eventsOfType(db, 'window.request')).toEqual([])
  })

  it.each([[undefined], [[]], [[0]], [['1451']], [[1.5]]])('a request naming ids %j is refused with its reason and records nothing', (ids) => {
    const { db } = busWithForeignRow(FOREIGN_ROW)
    const request = requestFromWindow(db, NOW.toISOString(), 'test', { kind: 'numbers.foreign', ids })

    expect(requests(db).run()).toEqual([{ kind: 'refused', request, detail: 'numbers.foreign needs --ids, a list of positive card numbers' }])
    expect(eventsOfType(db, 'numbers.foreign')).toEqual([])
  })
})

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
