import type { DatabaseSync } from 'node:sqlite'
import type { CardEvent } from '../../../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { recordIntake } from '../../../src/commands/intake/index.js'
import { openBus } from '../../core/db.js'
import { declarationFileOf, MODULE_FILES } from '../../core/declarations.js'
import { CARD_ADMITTED, CARD_WAITING } from '../../core/events.js'
import { busCardEvents } from '../../intake/intake.js'

const DRAFT = [2050, 2051, 2052, 2053, 2054, 2055]
const REFUSED = 2055
const NEW_FILE = 'scripts/x/new.ts'
const TS = '2026-11-18T10:00:00.000Z'
const OWNER = { module: 'x', layer: 'core', paths: ['scripts/x/'], exclude: [], shared: [] }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface World { root: string, db: DatabaseSync }

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'refusal-admits-nothing-')))
  roots.push(root)
  const declaration = path.join(root, declarationFileOf(OWNER.module))
  mkdirSync(path.dirname(declaration), { recursive: true })
  writeFileSync(declaration, `${JSON.stringify(OWNER, null, 2)}\n`)
  return { root, db: openBus(path.join(root, 'bus', 'bus.db')) }
}

function lineOf(id: number): string {
  return `#${id} card-${id} [implement/construct/S/cheap/auto] · depends — · blocks —`
}

function admittedEvent(id: number, extra: readonly string[], touches: readonly string[] = []): CardEvent {
  const text = [`card: ${lineOf(id)}`, `branch: feat/card-${id}`, `touches: ${['scripts/x/old.ts', ...touches].join(', ')}`, ...extra, 'continue: stop', 'who: shift', '', 'Do it.', ''].join('\n')
  return { type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: lineOf(id), depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } }
}

function waitingEvent(id: number): CardEvent {
  return { type: CARD_WAITING, cardId: id, ts: TS, dedupeKey: `wait-${id}`, payload: { reason: 'asks.the.window', code: 'stopped', detail: `#${id} given to the window` } }
}

function draftEvents(lastExtra: readonly string[], lastTouches: readonly string[] = []): CardEvent[] {
  const admitted = DRAFT.map(id => id === REFUSED ? admittedEvent(id, lastExtra, lastTouches) : admittedEvent(id, []))
  return [...admitted, ...DRAFT.map(waitingEvent)]
}

function eventsOfDraft(db: DatabaseSync): number {
  const marks = DRAFT.map(() => '?').join(', ')
  return (db.prepare(`SELECT count(*) AS n FROM events WHERE card_id IN (${marks})`).get(...DRAFT) as { n: number }).n
}

function admissionsOfDraft(db: DatabaseSync): number {
  const marks = DRAFT.map(() => '?').join(', ')
  return (db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND card_id IN (${marks})`).get(CARD_ADMITTED, ...DRAFT) as { n: number }).n
}

function inWorld(act: (w: World) => void): void {
  const w = newWorld()
  try {
    act(w)
  }
  finally {
    w.db.close()
  }
}

describe('a draft is admitted into the bus all or nothing', () => {
  it('a draft whose last card is refused by the creates-owner check leaves no card.admitted for any card of the draft', () => {
    inWorld((w) => {
      expect(() => recordIntake(draftEvents([`creates: ${NEW_FILE}`]), busCardEvents(w.db, 's742', undefined, w.root))).toThrow(new RegExp(`Refused: #${REFUSED} creates a file .*Nothing was admitted\\.`))
      expect(admissionsOfDraft(w.db)).toBe(0)
      expect(eventsOfDraft(w.db)).toBe(0)
    })
  })

  it('a draft whose last card names a release the bus has not opened leaves nothing of the draft in the bus', () => {
    inWorld((w) => {
      expect(() => recordIntake(draftEvents(['release: never-opened']), busCardEvents(w.db, 's742', undefined, w.root))).toThrow(/Nothing was admitted\./)
      expect(eventsOfDraft(w.db)).toBe(0)
    })
  })

  it('a draft whose last card carries the module files in its touches admits every card of it', () => {
    inWorld((w) => {
      recordIntake(draftEvents([`creates: ${NEW_FILE}`], [MODULE_FILES]), busCardEvents(w.db, 's742', undefined, w.root))
      expect(admissionsOfDraft(w.db)).toBe(DRAFT.length)
    })
  })

  it('a single card refused alone still leaves no card.admitted', () => {
    inWorld((w) => {
      const port = busCardEvents(w.db, 's742', undefined, w.root)
      expect(() => port(admittedEvent(REFUSED, [`creates: ${NEW_FILE}`]))).toThrow(/Nothing was admitted\./)
      expect(admissionsOfDraft(w.db)).toBe(0)
    })
  })
})
