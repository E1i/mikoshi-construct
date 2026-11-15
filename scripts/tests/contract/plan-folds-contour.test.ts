import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { specifiersIn } from '../../contract/module-graph/imports.js'
import { ownerOf } from '../../contract/module-graph/ownership.js'
import { CARD_PLANNED, CARD_UNPLANNED, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_OPENED } from '../../core/events.js'
import * as reducer from '../../core/reducer.js'
import { busProjections } from '../../supervisor/composition.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const REDUCER = 'scripts/core/reducer.ts'
const PLAN_FOLDS_FILE = 'scripts/window/plan-folds.ts'
const PLAN_TYPES = [PLAN_OPENED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_ITEM_REMOVED, PLAN_CLOSED, CARD_PLANNED, CARD_UNPLANNED, PLAN_BACKFILLED]
const NOT_IMPORTED_BY_THE_REDUCER = [/\/inbox\.js$/, /\/round-limit-decision\.js$/]

function importsOf(file: string): string[] {
  return specifiersIn(file, readFileSync(path.join(ROOT, file), 'utf8')).map(specifier => specifier.text)
}

function exportedFoldMaps(): object[] {
  return (Object.values(reducer) as unknown[]).filter((value): value is object => typeof value === 'object' && value !== null && !Array.isArray(value))
}

describe('the plan folds leave the reducer', () => {
  it.each(NOT_IMPORTED_BY_THE_REDUCER)('core/reducer.ts imports nothing matching %s', (pattern) => {
    expect(importsOf(REDUCER).filter(specifier => pattern.test(specifier))).toEqual([])
  })

  it('core/reducer.ts exports no fold of a plan event', () => {
    const planned = exportedFoldMaps().flatMap(folds => PLAN_TYPES.filter(type => Object.hasOwn(folds, type)))
    expect(planned).toEqual([])
    expect(Object.keys(reducer)).not.toContain('PLAN_FOLDS')
  })

  it('composition lists a fold for every plan event', () => {
    const listed = new Set(busProjections().folds.flatMap(folds => Object.keys(folds)))
    expect(PLAN_TYPES.filter(type => !listed.has(type))).toEqual([])
  })

  it('the plan module owns the file that holds the plan folds', () => {
    expect(ownerOf(MODULE_GRAPH, PLAN_FOLDS_FILE)).toEqual(['plan'])
  })
})
