import { withinTouches } from '../../src/card/covering-tests.js'

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
