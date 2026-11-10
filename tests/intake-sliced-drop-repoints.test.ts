import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { CARD_ADMITTED, CARD_DROPPED } from '../scripts/core/events.js'
import { reduce } from '../scripts/core/reducer.js'
import { busIntakePorts } from '../scripts/intake/intake.js'
import { AMEND_SOURCE, runAdmit } from '../src/commands/intake/admit.js'
import { admittedCardOf } from '../src/commands/intake/amend.js'
import { printMove, runMove } from '../src/commands/intake/move.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const AT = new Date('2026-11-10T09:00:00.000Z')
const DROPPED_AT = new Date('2026-11-10T10:00:00.000Z')
const PARENT = 1649
const DEPENDENT = 1662
const TAKER = 1784
const SIBLING = 1785
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, repo: string, db: DatabaseSync, ports: ReturnType<typeof busIntakePorts> }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'sliced-drop-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  const repo = path.join(root, 'repo')
  mkdirSync(parking)
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  const db = openBus(path.join(root, 'bus.db'))
  return { parking, repo, db, ports: busIntakePorts(db, 'by-hand', () => 1) }
}

function ids(cards: readonly number[]): string {
  return cards.length === 0 ? '—' : cards.map(card => `#${card}`).join(' ')
}

function admit(w: World, id: number, links: { depends?: number[], blocks?: number[] } = {}): void {
  const file = path.join(w.parking, `${id}.md`)
  writeFileSync(file, `card: #${id} card-${id} [implement/black-ice/S/cheap/owner] · depends ${ids(links.depends ?? [])} · blocks ${ids(links.blocks ?? [])}\nbranch: feat/card-${id}\ntouches: src/a.ts\ncontinue: stop\nwho: window\n\nDo the thing.\n`)
  const result = runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: w.ports.cardEvents, cardStates: w.ports.cardStates, admissions: w.ports.cardAdmissions }, () => AT)
  expect(result.status).toBe('admitted')
  reduce(w.db)
}

function slicedStub(w: World): void {
  rmSync(path.join(w.parking, `${PARENT}.md`))
  mkdirSync(path.join(w.parking, 'sliced'))
  writeFileSync(path.join(w.parking, 'sliced', `${PARENT}.md`), `sliced into #${TAKER}, #${SIBLING}\n`)
}

function drop(w: World, dryRun = false) {
  return runMove({ move: `#${PARENT}`, to: 'sliced', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, dryRun, events: w.ports.cardEvents, admissions: w.ports.cardAdmissions, cardStates: w.ports.cardStates }, () => DROPPED_AT)
}

function printed(result: ReturnType<typeof runMove>): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printMove(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

function eventCount(w: World): unknown {
  return w.db.prepare('SELECT count(*) AS n FROM events').get()
}

describe('a sliced drop and the cards that depend on the dropped card', () => {
  it('a sliced drop re-points the depends of an admitted card to the slice that names it in its blocks', () => {
    const w = world()
    try {
      admit(w, PARENT)
      admit(w, DEPENDENT, { depends: [PARENT] })
      admit(w, TAKER, { blocks: [DEPENDENT] })
      admit(w, SIBLING)
      slicedStub(w)
      const before = eventCount(w)
      const dry = drop(w, true)
      expect(dry).toMatchObject({ status: 'dryRun', repointed: [{ card: DEPENDENT, dropped: PARENT, children: [TAKER] }] })
      expect(printed(dry).lines[1]).toBe(`#${DEPENDENT} now depends on #${TAKER} instead of the dropped #${PARENT}.\n`)
      expect(eventCount(w)).toEqual(before)
      const result = drop(w)
      expect(result).toMatchObject({ status: 'recordedInPlace', event: CARD_DROPPED, repointed: [{ card: DEPENDENT, dropped: PARENT, children: [TAKER] }] })
      expect(reduce(w.db).rejected).toBe(0)
      expect(printed(result).lines.at(-1)).toBe(`#${DEPENDENT} now depends on #${TAKER} instead of the dropped #${PARENT}.\n`)
      const amended = w.db.prepare(`SELECT payload FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(DEPENDENT) as { payload: string }
      expect(JSON.parse(amended.payload)).toMatchObject({ source: AMEND_SOURCE, depends: [TAKER] })
      expect(admittedCardOf(w.ports.cardAdmissions!(DEPENDENT)!.text!)?.depends).toEqual([TAKER])
      expect(w.db.prepare(`SELECT state FROM cards WHERE card_id = ?`).get(PARENT)).toEqual({ state: 'dropped' })
    }
    finally {
      w.db.close()
    }
  })

  it('a sliced drop is refused while an admitted card depends on it and no slice names that card', () => {
    const w = world()
    try {
      admit(w, PARENT)
      admit(w, DEPENDENT, { depends: [PARENT] })
      admit(w, TAKER)
      admit(w, SIBLING)
      slicedStub(w)
      const before = eventCount(w)
      const result = drop(w)
      expect(result.status).toBe('refused')
      expect(printed(result)).toEqual({ lines: [expect.stringContaining(`#${DEPENDENT} depend on #${PARENT}`)], exit: 1 })
      expect(eventCount(w)).toEqual(before)
      expect(w.db.prepare(`SELECT state FROM cards WHERE card_id = ?`).get(PARENT)).not.toEqual({ state: 'dropped' })
    }
    finally {
      w.db.close()
    }
  })
})
