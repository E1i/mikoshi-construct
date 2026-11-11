import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { cardRunsOf } from '../../ci/card-runs.js'
import { BUS_CORE, BUS_SERVICE, fullRunReason, selectRun } from '../../ci/layers.js'
import { cruise, readTest } from '../../ci/select.js'
import { overlapWithMain, writeCatalog } from '../../cli/check-catalog.js'
import * as layerMap from '../../core/layer-map.js'
import { isCheckPipeline, layersIn, readLayerMap, recordsOf } from '../../core/layer-map.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const TEST_ROOT = 'scripts/tests/'
const ROOT_CONFIG = '.dependency-cruiser-known-violations.json'
const GLOBAL_FILE = 'pnpm-lock.yaml'
const UNREAD_ROOT_FILE = ['unread', 'root', 'cfg'].join('-')

function tracked(file: string): boolean {
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: REPO_ROOT, encoding: 'utf8' }).status === 0
}

function trackedSources(): string[] {
  const listed = spawnSync('git', ['ls-files', 'scripts', 'src'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return listed.stdout.split('\n').filter(file => file.endsWith('.ts') && !file.startsWith(TEST_ROOT))
}

describe('the layer map gives every source file one layer', () => {
  const map = readLayerMap()
  const sources = trackedSources()

  it('every tracked source file has exactly one layer in the map', () => {
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.filter(file => layersIn(map, file).length !== 1)).toEqual([])
  })

  it('every file entry of the map names a tracked source file, a contract record or a tracked root config', () => {
    const records = recordsOf(map)
    const rootConfigs = Object.keys(map.files).filter(file => !file.includes('/'))
    expect(rootConfigs).toContain(ROOT_CONFIG)
    expect(rootConfigs.filter(file => !tracked(file))).toEqual([])
    expect(Object.keys(map.files).filter(file => !sources.includes(file) && !records.includes(file) && !rootConfigs.includes(file))).toEqual([])
  })

  it('the only records in the map are the three tracked contract records, in the layer contract', () => {
    const records = recordsOf(map)
    expect(records.map(record => path.posix.basename(record)).sort()).toEqual(['accepted.json', 'factory.json', 'ratchet.json'])
    expect(records.filter(record => map.files[record] !== 'contract')).toEqual([])
    expect(records.filter(record => !tracked(record))).toEqual([])
  })

  it('a tracked file with no layer of its readers and not in the list of global files of the contract fails the check', () => {
    const files = spawnSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.split('\n').filter(file => file !== '')
    const graph = cruise()
    const texts = new Map<string, string>()
    const text = (module: string): string => texts.get(module) ?? texts.set(module, readTest(module)).get(module)!
    const globals = layerMap.readGlobalFiles()
    expect(globals.filter(file => !files.includes(file))).toEqual([])
    expect(fullRunReason([UNREAD_ROOT_FILE], graph, text, map)).toBe(`${UNREAD_ROOT_FILE} belongs to no layer of the dependency graph`)
    const full = files.filter(file => !isCheckPipeline(file) && fullRunReason([file], graph, text, map) !== null)
    expect(full.filter(file => !globals.includes(file))).toEqual([])
    expect(globals.filter(file => !isCheckPipeline(file) && !full.includes(file))).toEqual([])
    expect(selectRun(['scripts/construct/daemon.mjs'], graph, text, map).kind).toBe('layers')
  }, 120_000)

  it('a root config read by one tool takes the layer of that tool and its tests, and selectRun and cardRunsOf name the same reason', () => {
    const graph = cruise()
    const texts = new Map<string, string>()
    const text = (module: string): string => texts.get(module) ?? texts.set(module, readTest(module)).get(module)!
    expect(layersIn(map, ROOT_CONFIG)).toEqual(['ci'])
    const run = selectRun([ROOT_CONFIG], graph, text, map)
    expect(run).toMatchObject({ kind: 'layers' })
    expect(run.kind === 'layers' && run.layers.includes('ci')).toBe(true)
    const catalog = { testLayers: new Map([['scripts/tests/ci/layers.test.ts', ['ci']]]), moduleLayers: new Map([['scripts/ci/layers.ts', ['ci']]]) }
    expect(cardRunsOf({ touches: [ROOT_CONFIG], runs: [], masks: [] }, catalog, map)).toEqual({ layers: ['ci'], paths: [], tests: ['scripts/tests/ci/layers.test.ts'] })
    const why = layerMap.globalRunReason(map, GLOBAL_FILE)
    expect(why).toBe(`${GLOBAL_FILE} is a global file of contract/factory.json, which takes the full run`)
    expect(cardRunsOf({ touches: [GLOBAL_FILE], runs: [], masks: [] }, catalog, map)).toEqual({ full: true, why })
    expect(fullRunReason(['tsconfig.json'], graph, text, map)).toBe(layerMap.globalRunReason(map, 'tsconfig.json'))
    expect(cardRunsOf({ touches: ['tsconfig.json'], runs: [], masks: [] }, catalog, map)).toEqual({ full: true, why: layerMap.globalRunReason(map, 'tsconfig.json') })
  }, 120_000)

  it('a file entry wins over the folder that holds it', () => {
    expect(layersIn({ files: { 'scripts/core/queue.ts': 'core' }, folders: { 'scripts/bus/': 'bus' } }, 'scripts/core/queue.ts')).toEqual(['core'])
    expect(layersIn({ files: {}, folders: { 'scripts/release/': 'release', 'scripts/release-notes/': 'release-notes' } }, 'scripts/release-notes/render.ts')).toEqual(['release-notes'])
  })

  it('a fixture under the tests folder takes the layers of the tests beside it', () => {
    const fixture = 'scripts/tests/core/owner-commands-pending.json'
    const db = new DatabaseSync(':memory:')
    writeCatalog(db, { tests: [
      { test: 'scripts/tests/core/owner-commands.test.ts', layer: 'core', kind: 'unit', what: '', witness: '' },
      { test: 'scripts/tests/bus/queue.test.ts', layer: 'bus', kind: 'unit', what: '', witness: '' },
    ], mutations: [] })
    const overlap = overlapWithMain(db, [], [fixture], () => null, { map })
    expect(overlap ?? '').not.toContain('belongs to no layer')
    expect(overlapWithMain(db, ['scripts/tests/core/owner-commands.test.ts'], [fixture], () => null, { map })).toBe('main changed the layer core since the base')
    expect(overlapWithMain(db, ['scripts/tests/bus/queue.test.ts'], [fixture], () => null, { map })).toBeNull()
    expect(layerMap.isTestFixture(fixture)).toBe(true)
    expect(layerMap.isTestFixture('scripts/tests/core/owner-commands.test.ts')).toBe(false)
    const testLayers = new Map([['scripts/tests/core/owner-commands.test.ts', ['core']], ['scripts/tests/bus/queue.test.ts', ['bus']]])
    expect(layerMap.layersOfTestFixture('scripts/tests/core/fixtures/pending.json', testLayers)).toEqual(['core'])
    expect(layerMap.layersOfTestFixture('scripts/tests/ghosts/pending.json', testLayers)).toEqual([])
    db.close()
  })

  it('names the bus core and each bus service the way the dependency rules see them', () => {
    const bus = sources.filter(file => BUS_CORE.test(file) || BUS_SERVICE.test(file))
    expect(bus.length).toBeGreaterThan(0)
    for (const file of bus)
      expect([file, map.files[file]]).toEqual([file, BUS_CORE.test(file) ? 'bus-core' : `bus:${BUS_SERVICE.exec(file)![1]}`])
  })
})
