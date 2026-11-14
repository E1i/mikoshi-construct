import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { openBus } from '../../core/db.js'
import { createsOwnerRefusals, declarationFileOf, MODULE_FILES, nearestModulesOf } from '../../core/declarations.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { busCardEvents, createsOwnerRefusalOf } from '../../intake/intake.js'

const CARD = 1929
const LINE = `#${CARD} creates-owner [implement/construct/M/cheap/auto] · depends — · blocks —`
const NEW_FILE = 'scripts/x/new.ts'
const OWNER = 'x'
const NEIGHBOUR = 'core'
const OWNER_DECLARATION = declarationFileOf(OWNER)
const TS = '2026-11-14T10:00:00.000Z'
const roots: string[] = []

const UNCOVERED = { module: NEIGHBOUR, layer: 'core', paths: ['scripts/core/'], exclude: [], shared: [] }
const COVERING = { module: OWNER, layer: 'core', paths: ['scripts/x/'], exclude: [], shared: [] }

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface World { root: string, db: DatabaseSync }

function newWorld(modules: readonly typeof UNCOVERED[]): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'creates-owner-')))
  roots.push(root)
  const folder = path.join(root, path.dirname(declarationFileOf(NEIGHBOUR)))
  mkdirSync(folder, { recursive: true })
  for (const module of modules)
    writeFileSync(path.join(root, declarationFileOf(module.module)), `${JSON.stringify(module, null, 2)}\n`)
  return { root, db: openBus(path.join(root, 'bus', 'bus.db')) }
}

function cardText(touches: readonly string[]): string {
  return `card: ${LINE}\nbranch: feat/creates-owner\ntouches: ${touches.join(', ')}\ncreates: ${NEW_FILE}\ncontinue: stop\nwho: shift\n\nCreate the file.\n`
}

function admit(w: World, touches: readonly string[]): void {
  const text = cardText(touches)
  busCardEvents(w.db, 's1', () => 1, undefined, w.root)({ type: CARD_ADMITTED, cardId: CARD, ts: TS, dedupeKey: `admit-${CARD}`, payload: { card: LINE, lane: null, depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
}

function admissions(w: World): number {
  return (w.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND card_id = ?`).get(CARD_ADMITTED, CARD) as { n: number }).n
}

function inWorld(modules: readonly typeof UNCOVERED[], act: (w: World) => void): void {
  const w = newWorld(modules)
  try {
    act(w)
  }
  finally {
    w.db.close()
  }
}

describe('a card is admitted only when its touches reach the owner module of every path it creates', () => {
  it('a card creating a path no module declares is refused naming the path', () => {
    inWorld([UNCOVERED], (w) => {
      expect(() => admit(w, ['scripts/core/declarations.ts'])).toThrow(new RegExp(`Refused: #${CARD} .*${NEW_FILE} resolves to no module; widen ${NEIGHBOUR} to cover it; add ${declarationFileOf(NEIGHBOUR)}, ${MODULE_FILES} to touches`))
      expect(admissions(w)).toBe(0)
    })
  })

  it('a card that widens the owner module declaration in its touches is admitted', () => {
    inWorld([UNCOVERED, COVERING], (w) => {
      admit(w, ['scripts/core/declarations.ts', OWNER_DECLARATION, MODULE_FILES])
      expect(admissions(w)).toBe(1)
    })
  })

  it('a create under an already-covering owner with only module-files.json in touches is admitted', () => {
    inWorld([UNCOVERED, COVERING], (w) => {
      admit(w, [MODULE_FILES])
      expect(admissions(w)).toBe(1)
    })
  })

  it('a card creating a path an owner already covers is refused without the module files, naming the module and only that file', () => {
    inWorld([UNCOVERED, COVERING], (w) => {
      expect(() => admit(w, ['scripts/core/declarations.ts'])).toThrow(`${NEW_FILE} belongs to module ${OWNER}; add ${MODULE_FILES} to touches.`)
      expect(admissions(w)).toBe(0)
    })
  })

  it('a card creating an unowned path is admitted once it names a declaration to widen and the module files', () => {
    inWorld([UNCOVERED], (w) => {
      admit(w, [declarationFileOf(NEIGHBOUR), MODULE_FILES])
      expect(admissions(w)).toBe(1)
    })
  })

  it('a repository with no module declarations admits the card unchecked', () => {
    inWorld([], (w) => {
      admit(w, ['scripts/core/declarations.ts'])
      expect(admissions(w)).toBe(1)
    })
  })
})

describe('createsOwnerRefusals', () => {
  const modules = [UNCOVERED, COVERING]
  const touching = (touches: readonly string[]) => (file: string) => touches.includes(file)

  it('asks an owned path for the module files only, never for the declaration that already covers it', () => {
    expect(createsOwnerRefusals(modules, [NEW_FILE], touching([]))).toEqual([{ path: NEW_FILE, owner: OWNER, modules: [OWNER], add: [MODULE_FILES] }])
    expect(createsOwnerRefusals(modules, [NEW_FILE], touching([MODULE_FILES]))).toEqual([])
  })

  it('names no module for a path far from every declared folder', () => {
    expect(createsOwnerRefusals(modules, ['docs/new.md'], touching([]))).toEqual([{ path: 'docs/new.md', owner: null, modules: [], add: [MODULE_FILES] }])
  })

  it('takes the nearest module by shared folders for an unowned path', () => {
    expect(nearestModulesOf(modules, 'scripts/core/order/new.ts')).toEqual([NEIGHBOUR])
    expect(nearestModulesOf(modules, 'scripts/y/new.ts')).toEqual([NEIGHBOUR, OWNER])
  })

  it('a refusal of a path that is not an admitted card event is none', () => {
    expect(createsOwnerRefusalOf(modules, { type: 'card.moved', cardId: CARD, ts: TS, dedupeKey: 'm', payload: { text: cardText([]) } })).toBeNull()
  })
})
