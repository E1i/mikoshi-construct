import type { DatabaseSync } from 'node:sqlite'
import type { CardEventPort } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../scripts/core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, FACTORY_MODE } from '../scripts/core/events.js'
import { reduce } from '../scripts/core/reducer.js'
import { busIntakePorts } from '../scripts/intake/intake.js'
import { busProjections } from '../scripts/supervisor/composition.js'
import { AMEND_SOURCE, runAdmit } from '../src/commands/intake/admit.js'
import { admittedCardOf, runAmend } from '../src/commands/intake/amend.js'
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

function world(lanes = 1): World {
  const root = mkdtempSync(path.join(tmpdir(), 'sliced-drop-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  const repo = path.join(root, 'repo')
  mkdirSync(parking)
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  const db = openBus(path.join(root, 'bus.db'))
  return { parking, repo, db, ports: busIntakePorts(db, 'by-hand', () => lanes) }
}

function ids(cards: readonly number[]): string {
  return cards.length === 0 ? '—' : cards.map(card => `#${card}`).join(' ')
}

function admit(w: World, id: number, links: { depends?: number[], blocks?: number[] } = {}, lane = '.'): void {
  mkdirSync(path.join(w.parking, lane), { recursive: true })
  const file = path.join(w.parking, lane, `${id}.md`)
  writeFileSync(file, `card: #${id} card-${id} [implement/black-ice/S/cheap/owner] · depends ${ids(links.depends ?? [])} · blocks ${ids(links.blocks ?? [])}\nbranch: feat/card-${id}\ntouches: src/a.ts\ncontinue: stop\nwho: window\n\nDo the thing.\n`)
  const result = runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: w.ports.cardEvents, cardStates: w.ports.cardStates, admissions: w.ports.cardAdmissions }, () => AT)
  expect(result.status).toBe('admitted')
  reduce(w.db, 'pending', busProjections())
}

function slicedStub(w: World): void {
  rmSync(path.join(w.parking, `${PARENT}.md`))
  mkdirSync(path.join(w.parking, 'sliced'))
  writeFileSync(path.join(w.parking, 'sliced', `${PARENT}.md`), `sliced into #${TAKER}, #${SIBLING}\n`)
}

function drop(w: World, dryRun = false, events: CardEventPort = w.ports.cardEvents) {
  return runMove({ move: `#${PARENT}`, to: 'sliced', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, dryRun, events, admissions: w.ports.cardAdmissions, cardStates: w.ports.cardStates }, () => DROPPED_AT)
}

function printed(result: ReturnType<typeof runMove>): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printMove(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

function eventCount(w: World): unknown {
  return w.db.prepare('SELECT count(*) AS n FROM events').get()
}

function latestAdmission(w: World, card: number): Record<string, unknown> {
  const row = w.db.prepare(`SELECT payload FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(card) as { payload: string }
  return JSON.parse(row.payload) as Record<string, unknown>
}

function admissionCount(w: World, card: number): unknown {
  return w.db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = ?`).get(card)
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
      expect(reduce(w.db, 'pending', busProjections()).rejected).toBe(0)
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

  it('a re-pointed dependent keeps its own lane in parallel mode, not the lane of the slice it now depends on', () => {
    const w = world(4)
    try {
      appendEvent(w.db, { ts: AT.toISOString(), type: FACTORY_MODE, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${FACTORY_MODE}:parallel`, payload: { mode: 'parallel' }, legacy: false })
      admit(w, PARENT)
      admit(w, DEPENDENT, { depends: [PARENT] })
      admit(w, TAKER, { blocks: [DEPENDENT] })
      admit(w, SIBLING)
      slicedStub(w)
      const lane = latestAdmission(w, DEPENDENT).lane
      expect(typeof lane).toBe('string')
      expect(latestAdmission(w, TAKER).lane).not.toBe(lane)
      expect(drop(w).status).toBe('recordedInPlace')
      expect(reduce(w.db, 'pending', busProjections()).rejected).toBe(0)
      expect(latestAdmission(w, DEPENDENT)).toMatchObject({ source: AMEND_SOURCE, depends: [TAKER], lane })
      expect(w.db.prepare('SELECT lane FROM card_bodies WHERE card_id = ?').get(DEPENDENT)).toEqual({ lane })
    }
    finally {
      w.db.close()
    }
  })

  it('a sliced drop re-points a dependent from its latest card.admitted while the reducer has not folded that amend yet', () => {
    const w = world()
    try {
      admit(w, PARENT)
      admit(w, DEPENDENT, { depends: [PARENT] })
      admit(w, TAKER, { blocks: [DEPENDENT] })
      admit(w, SIBLING)
      const amended = runAmend({ card: `#${DEPENDENT}`, flags: { note: 'The amended line.' }, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: w.ports.cardEvents, cardStates: w.ports.cardStates, admissions: w.ports.cardAdmissions }, () => AT)
      expect(amended.status).toBe('admitted')
      slicedStub(w)
      expect(w.db.prepare('SELECT text FROM card_bodies WHERE card_id = ?').get(DEPENDENT)).not.toEqual({ text: expect.stringContaining('The amended line.') })
      expect(drop(w)).toMatchObject({ status: 'recordedInPlace', repointed: [{ card: DEPENDENT, children: [TAKER] }] })
      expect(reduce(w.db, 'pending', busProjections()).rejected).toBe(0)
      const text = w.ports.cardAdmissions!(DEPENDENT)!.text!
      expect(admittedCardOf(text)?.depends).toEqual([TAKER])
      expect(text).toContain('The amended line.')
    }
    finally {
      w.db.close()
    }
  })

  it('a slice that blocks a dependent but also depends on it does not take it over, so the drop is refused', () => {
    const w = world()
    try {
      admit(w, PARENT)
      admit(w, DEPENDENT, { depends: [PARENT] })
      admit(w, TAKER, { depends: [DEPENDENT], blocks: [DEPENDENT] })
      admit(w, SIBLING)
      slicedStub(w)
      const before = eventCount(w)
      const result = drop(w)
      expect(result.status).toBe('refused')
      expect(printed(result).lines.join('')).toContain(`#${DEPENDENT} depend on #${PARENT}`)
      expect(eventCount(w)).toEqual(before)
    }
    finally {
      w.db.close()
    }
  })

  it('a drop whose own record fails puts the stub back, and a re-run drops it without re-pointing twice', () => {
    const w = world()
    try {
      admit(w, PARENT)
      admit(w, DEPENDENT, { depends: [PARENT] })
      admit(w, TAKER, { blocks: [DEPENDENT] })
      admit(w, SIBLING)
      rmSync(path.join(w.parking, `${PARENT}.md`))
      writeFileSync(path.join(w.parking, `${PARENT}.md`), `sliced into #${TAKER}, #${SIBLING}\n`)
      const failingDrop: CardEventPort = (event) => {
        if (event.type === CARD_DROPPED)
          throw new Error('the bus refused the drop')
        w.ports.cardEvents!(event)
      }
      expect(() => drop(w, false, failingDrop)).toThrow('the bus refused the drop')
      expect(existsSync(path.join(w.parking, `${PARENT}.md`))).toBe(true)
      expect(existsSync(path.join(w.parking, 'sliced'))).toBe(false)
      reduce(w.db, 'pending', busProjections())
      expect(admittedCardOf(w.ports.cardAdmissions!(DEPENDENT)!.text!)?.depends).toEqual([TAKER])
      const admissions = admissionCount(w, DEPENDENT)
      expect(drop(w)).toMatchObject({ status: 'moved', event: CARD_DROPPED })
      expect(admissionCount(w, DEPENDENT)).toEqual(admissions)
      expect(reduce(w.db, 'pending', busProjections()).rejected).toBe(0)
      expect(w.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(PARENT)).toEqual({ state: 'dropped' })
    }
    finally {
      w.db.close()
    }
  })
})
