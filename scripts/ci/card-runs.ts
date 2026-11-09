import type { DatabaseSync } from 'node:sqlite'
import type { LayerMap } from '../core/layer-map.js'
import { existsSync } from 'node:fs'
import { isTest, layerMasksOf, runsOf, withinTouches } from '../../src/card/covering-tests.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { CARD_BODIES } from '../core/card-bodies.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { messageOf } from '../core/errors.js'
import { globalRunReason, layersOfEntry, readLayerMap } from '../core/layer-map.js'
import { openDatabase } from '../core/sqlite.js'
import { CHANGESET_READERS, declaredReadersOf, isChangesetNote } from './layers.js'

export const NO_LAYER = 'none'

const CARD_OF_BRANCH = `SELECT card_id, text FROM ${CARD_BODIES} WHERE branch = ? LIMIT 2`
const CARD_OF_PR = `SELECT body.card_id, body.text FROM prs JOIN ${CARD_BODIES} body ON body.card_id = prs.card_id WHERE prs.pr = ?`

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

export class LayerWithoutTests extends Error {
  constructor(readonly layer: string) {
    super(`layer ${layer} meets no test of the check catalog`)
    this.name = 'LayerWithoutTests'
  }
}

export type CardRuns
  = | { full: true, why: string }
    | { layers: string[], paths: string[], tests: string[] }

function filesWithin(entry: string, catalog: LayersByFile): string[] {
  return [...catalog.keys()].filter(file => withinTouches(file, [entry]))
}

const TRAILING_GLOB = /\*\*$/

function declaredReaderLayers(touch: string, moduleLayers: LayersByFile): string[] {
  return (declaredReadersOf(touch.replace(TRAILING_GLOB, '')) ?? []).flatMap(reader => moduleLayers.get(reader) ?? [])
}

function touchedLayers(touch: string, moduleLayers: LayersByFile, map: LayerMap): string[] {
  const catalogued = filesWithin(touch, moduleLayers).flatMap(file => moduleLayers.get(file) ?? [])
  return catalogued.length > 0 ? catalogued : sortedUnique([...layersOfEntry(map, touch), ...declaredReaderLayers(touch, moduleLayers)])
}

function testsOfTouch(touch: string, testLayers: LayersByFile): string[] {
  if (isChangesetNote(touch))
    return CHANGESET_READERS.filter(test => testLayers.has(test))
  const within = filesWithin(touch, testLayers)
  return within.length === 0 && isTest(touch) ? [touch] : within
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function coveredBy(entry: string, tests: ReadonlySet<string>, testLayers: LayersByFile): boolean {
  const within = filesWithin(entry, testLayers)
  return within.length > 0 && within.every(test => tests.has(test))
}

function testsOfLayers(layers: readonly string[], testLayers: LayersByFile): Set<string> {
  return new Set([...testLayers].filter(([, own]) => own.some(layer => layers.includes(layer))).map(([test]) => test))
}

function runsCoverTouch(touch: string, { runs, masks }: CardRunsSource, { testLayers, moduleLayers }: CheckCatalog, map: LayerMap): boolean {
  if (withinTouches(touch, runs))
    return true
  const layers = touchedLayers(touch, moduleLayers, map)
  if (layers.length === 0)
    return false
  const ran = [...testsOfLayers(masks, testLayers), ...runs.flatMap(entry => filesWithin(entry, testLayers))]
  return layers.every(layer => masks.includes(layer)) || ran.some(test => layers.every(layer => testLayers.get(test)?.includes(layer)))
}

export function cardRunsOf(source: CardRunsSource, catalog: CheckCatalog, map: LayerMap = readLayerMap()): CardRuns {
  const { touches, runs, masks } = source
  const { testLayers, moduleLayers } = catalog
  if (testLayers.size === 0 || moduleLayers.size === 0)
    return { full: true, why: 'the check catalog is empty' }
  const global = touches.map(touch => globalRunReason(map, touch)).find((reason): reason is string => reason !== null)
  if (global !== undefined)
    return { full: true, why: global }
  const followed = touches.filter(touch => !runsCoverTouch(touch, source, catalog, map))
  const unknown = followed.find(touch => touchedLayers(touch, moduleLayers, map).length === 0 && testsOfTouch(touch, testLayers).length === 0 && !isChangesetNote(touch))
  if (unknown !== undefined)
    return { full: true, why: `${unknown} belongs to no layer of the check catalog` }
  const layers = sortedUnique([...masks, ...followed.flatMap(touch => touchedLayers(touch, moduleLayers, map))])
  const catalogued = [...testLayers.values()].flat()
  const untested = layers.find(layer => !catalogued.includes(layer))
  if (untested !== undefined)
    throw new LayerWithoutTests(untested)
  const ofLayers = testsOfLayers(layers, testLayers)
  const paths = runs.filter(entry => !coveredBy(entry, ofLayers, testLayers))
  const tests = sortedUnique([...ofLayers, ...followed.flatMap(touch => testsOfTouch(touch, testLayers)), ...paths])
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

interface CardTextRow { card_id: number, text: string }

function runsSourceOf(row: CardTextRow): CardRunsSource | null {
  const parsed = parseParkingFile(`${row.card_id}.md`, row.text)
  if (parsed.kind === 'refused')
    return null
  const { touches, body } = parsed.parked.task
  return { touches, runs: runsOf(body), masks: layerMasksOf(body) }
}

export function runsSourceOfBranch(db: DatabaseSync, branch: string): CardRunsSource | null {
  const rows = hasTable(db, CARD_BODIES) ? db.prepare(CARD_OF_BRANCH).all(branch) as unknown as CardTextRow[] : []
  return rows.length === 1 ? runsSourceOf(rows[0]!) : null
}

export function runsSourceOfPr(db: DatabaseSync, pr: number): CardRunsSource | null {
  const row = hasTable(db, CARD_BODIES) && hasTable(db, 'prs') ? db.prepare(CARD_OF_PR).get(pr) as unknown as CardTextRow | undefined : undefined
  return row === undefined ? null : runsSourceOf(row)
}

export interface BusCatalog extends CheckCatalog {
  unreadable?: string
}

export type BranchCardRuns = { kind: 'no-card' } | { kind: 'unreadable', why: string } | { kind: 'card', reading: CardRuns }

export function branchCardRuns(branch: string, busPath: string = defaultBusPath()): BranchCardRuns {
  if (!existsSync(busPath))
    return { kind: 'no-card' }
  let db: DatabaseSync | undefined
  try {
    db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    const source = runsSourceOfBranch(db, branch)
    return source === null ? { kind: 'no-card' } : { kind: 'card', reading: cardRunsOf(source, { testLayers: catalogLayersByTest(db), moduleLayers: catalogModuleLayers(db) }) }
  }
  catch (error) {
    if (error instanceof LayerWithoutTests)
      throw error
    return { kind: 'unreadable', why: messageOf(error) }
  }
  finally {
    db?.close()
  }
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
