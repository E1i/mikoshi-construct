import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { withinTouches } from '../../src/card/covering-tests.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { messageOf } from '../core/errors.js'
import { openDatabase } from '../core/sqlite.js'

export const NO_LAYER = 'none'

type LayersByFile = ReadonlyMap<string, readonly string[]>

export interface CardRunsSource {
  touches: readonly string[]
  runs: readonly string[]
  masks: readonly string[]
}

export interface CheckCatalog {
  testLayers: LayersByFile
  moduleLayers: LayersByFile
}

export type CardRuns
  = | { full: true, why: string }
    | { layers: string[], paths: string[], tests: string[] }

function filesWithin(entry: string, catalog: LayersByFile): string[] {
  return [...catalog.keys()].filter(file => withinTouches(file, [entry]))
}

function layersOfTouch(touch: string, moduleLayers: LayersByFile): string[] {
  return filesWithin(touch, moduleLayers).flatMap(file => moduleLayers.get(file) ?? [])
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function coveredBy(entry: string, tests: ReadonlySet<string>, testLayers: LayersByFile): boolean {
  const within = filesWithin(entry, testLayers)
  return within.length > 0 && within.every(test => tests.has(test))
}

export function cardRunsOf({ touches, runs, masks }: CardRunsSource, { testLayers, moduleLayers }: CheckCatalog): CardRuns {
  if (testLayers.size === 0 || moduleLayers.size === 0)
    return { full: true, why: 'the check catalog is empty' }
  const followsTouches = runs.length === 0 && masks.length === 0
  const followed = followsTouches ? touches : []
  const unknown = followed.find(touch => layersOfTouch(touch, moduleLayers).length === 0 && filesWithin(touch, testLayers).length === 0)
  if (unknown !== undefined)
    return { full: true, why: `${unknown} belongs to no layer of the check catalog` }
  const layers = sortedUnique([...masks, ...followed.flatMap(touch => layersOfTouch(touch, moduleLayers))])
  const catalogued = [...testLayers.values()].flat()
  const untested = layers.find(layer => !catalogued.includes(layer))
  if (untested !== undefined)
    return { full: true, why: `layer ${untested} meets no test of the check catalog` }
  const ofLayers = new Set([...testLayers].filter(([, own]) => own.some(layer => layers.includes(layer))).map(([test]) => test))
  const paths = runs.filter(entry => !coveredBy(entry, ofLayers, testLayers))
  const tests = sortedUnique([...ofLayers, ...followed.flatMap(touch => filesWithin(touch, testLayers)), ...paths])
  if (tests.length === 0)
    return { full: true, why: 'the card names no touch and no run' }
  return { layers, paths, tests }
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
}

export function catalogModuleLayers(db: DatabaseSync): Map<string, string[]> {
  if (!hasTable(db, 'check_modules'))
    return new Map()
  const rows = db.prepare('SELECT module, layers FROM check_modules').all() as unknown as { module: string, layers: string }[]
  return new Map(rows.map(row => [row.module, row.layers.split(',').filter(layer => layer !== '')]))
}

export function catalogLayersByTest(db: DatabaseSync): Map<string, string[]> {
  if (!hasTable(db, 'check_tests'))
    return new Map()
  const rows = db.prepare('SELECT test, layer FROM check_tests').all() as unknown as { test: string, layer: string }[]
  return new Map(rows.map(row => [row.test, row.layer.split(',').filter(layer => layer !== NO_LAYER)]))
}

export interface BusCatalog extends CheckCatalog {
  unreadable?: string
}

export function busCheckCatalog(busPath: string = defaultBusPath()): BusCatalog {
  if (!existsSync(busPath))
    return { testLayers: new Map(), moduleLayers: new Map() }
  let db: DatabaseSync | undefined
  try {
    db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    return { testLayers: catalogLayersByTest(db), moduleLayers: catalogModuleLayers(db) }
  }
  catch (error) {
    return { testLayers: new Map(), moduleLayers: new Map(), unreadable: `the check catalog could not be read: ${messageOf(error)}` }
  }
  finally {
    db?.close()
  }
}

export interface CardReading {
  runs: string[]
  fullReading?: string
}

export function cardReadingOf(touches: readonly string[], named: string[], masks: readonly string[], catalog: BusCatalog): CardReading {
  if (catalog.unreadable !== undefined)
    return { runs: named, fullReading: catalog.unreadable }
  const reading = cardRunsOf({ touches, runs: named, masks }, catalog)
  return 'full' in reading
    ? { runs: named, fullReading: reading.why }
    : { runs: [...new Set([...named, ...reading.tests])] }
}
