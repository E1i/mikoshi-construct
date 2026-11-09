import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runsLine } from '../../../src/card/covering-tests.js'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { branchCardRuns, cardReadingOf, cardRunsOf, LayerWithoutTests } from '../../ci/card-runs.js'
import { cruise } from '../../ci/select.js'
import { catalogModules, catalogTests, overlapWithMain, testFoldersOfLayers, writeCatalog } from '../../cli/check-catalog.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { readLayerMap } from '../../core/layer-map.js'
import { reduce } from '../../core/reducer.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const CATALOG_BUILD_MS = 300_000
const CORE = 'scripts/core/a.ts'
const CORE_TEST = 'scripts/tests/core/a.test.ts'
const OTHER = 'scripts/other/a.ts'
const OTHER_TEST = 'scripts/tests/other/a.test.ts'
const UNTESTED = 'untested'
const UNTESTED_MESSAGE = `layer ${UNTESTED} meets no test of the check catalog`
const BRANCH = 'feat/a-card'
const CARD_ID = 1070
const CARD_LINE = `#${CARD_ID} a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —`
const MAP = { files: {}, folders: { 'scripts/core/': 'core', 'scripts/other/': 'other' } }
const CATALOG = {
  testLayers: new Map([[CORE_TEST, ['core']], [OTHER_TEST, ['other']]]),
  moduleLayers: new Map([[CORE, ['core']], [OTHER, ['other']]]),
}
const CARD = { touches: [CORE], runs: [], masks: [UNTESTED] }

const roots: string[] = []
const buses: DatabaseSync[] = []

afterEach(() => {
  for (const bus of buses.splice(0))
    bus.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function catalogBus(): { db: DatabaseSync, file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'layer-has-tests-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  const db = openBus(file)
  buses.push(db)
  writeCatalog(db, {
    tests: [...CATALOG.testLayers].map(([test, layers]) => ({ test, layer: layers.join(','), kind: 'unit', what: '', witness: '' })),
    mutations: [],
    modules: [...CATALOG.moduleLayers].map(([module, layers]) => ({ module, layers: [...layers] })),
  })
  return { db, file }
}

function admitUntested(db: DatabaseSync): void {
  const text = parkingFileText({ card: CARD_LINE, branch: BRANCH, touches: [CORE], continue: 'stop', who: 'shift', body: `Do it.\n\n${runsLine([`layer:${UNTESTED}`])}` })
  appendCardEvent(db, 'owner', { ts: '2026-11-05T00:00:00.000Z', type: CARD_ADMITTED, cardId: CARD_ID, dedupeKey: `${CARD_ADMITTED}:${CARD_ID}`, payload: { text, textSha: textSha(text) } })
  reduce(db)
}

describe('the law: every layer of the check catalog has a test', () => {
  it('every layer of the check catalog has at least one test', () => {
    const graph = cruise()
    const text = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const tests = catalogTests({ graph, testText: text, cards: [], briefs: [], journal: '' })
    const tested = new Set(tests.flatMap(test => test.layer.split(',')))
    const map = readLayerMap()
    const layers = new Set([
      ...catalogModules(graph).flatMap(module => module.layers),
      ...Object.values(map.folders),
      ...Object.values(map.files),
    ])
    expect([...layers].filter(layer => !tested.has(layer)).sort()).toEqual([])
  }, CATALOG_BUILD_MS)

  it('a layer with no test of the check catalog fails instead of choosing the full run', () => {
    const catalog = {
      testLayers: new Map([['scripts/tests/core/a.test.ts', ['core']]]),
      moduleLayers: new Map([['scripts/ci/a.ts', ['ci']], ['scripts/core/a.ts', ['core']]]),
    }
    const read = (): unknown => cardRunsOf({ touches: ['scripts/ci/a.ts'], runs: [], masks: [] }, catalog, { files: {}, folders: { 'scripts/ci/': 'ci', 'scripts/core/': 'core' } })
    expect(read).toThrow(LayerWithoutTests)
    expect(read).toThrow('layer ci meets no test of the check catalog')
  })

  it('scripts/tests/ci tests belong to layer ci', () => {
    expect(testFoldersOfLayers(readLayerMap())).toContainEqual(['scripts/tests/ci/', 'ci'])
    const test = 'scripts/tests/ci/layer-has-tests.test.ts'
    const tests = catalogTests({ graph: new Map([[test, []]]), testText: () => '', cards: [], briefs: [], journal: '' })
    expect(tests.find(entry => entry.test === test)?.layer.split(',')).toContain('ci')
  })

  it('the pre-push reading of a branch fails on a layer with no test instead of reading the bus as unreadable', () => {
    const { db, file } = catalogBus()
    admitUntested(db)

    expect(() => branchCardRuns(BRANCH, file)).toThrow(LayerWithoutTests)
    expect(() => branchCardRuns(BRANCH, file)).toThrow(UNTESTED_MESSAGE)
  })

  it('the launch and review reading of a card fails on a layer with no test instead of choosing the full run', () => {
    expect(() => cardReadingOf(CARD.touches, [], CARD.masks, CATALOG)).toThrow(LayerWithoutTests)
    expect(() => cardReadingOf(CARD.touches, [], CARD.masks, CATALOG)).toThrow(UNTESTED_MESSAGE)
  })

  it('the overlap with main names the layer with no test as the reason to rerun', () => {
    const { db } = catalogBus()

    expect(overlapWithMain(db, [CORE], [OTHER], () => null, { card: CARD, map: MAP })).toBe(UNTESTED_MESSAGE)
  })
})
