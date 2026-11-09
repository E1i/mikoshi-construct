import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardRunsOf, LayerWithoutTests } from '../../ci/card-runs.js'
import { cruise } from '../../ci/select.js'
import { catalogModules, catalogTests, testFoldersOfLayers } from '../../cli/check-catalog.js'
import { readLayerMap } from '../../core/layer-map.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const CATALOG_BUILD_MS = 300_000

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
})
