import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUS_CORE, BUS_SERVICE, fullRunReason, isRootConfigOrWorkflow, selectRun } from '../../ci/layers.js'
import { cruise, readTest } from '../../ci/select.js'
import { isCheckPipeline, layersIn, readLayerMap, recordsOf } from '../../core/layer-map.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const TEST_ROOT = 'scripts/tests/'
const WORKFLOWS = '.github/workflows/'

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

  it('every file entry of the map names a tracked source file or a contract record', () => {
    const records = recordsOf(map)
    expect(Object.keys(map.files).filter(file => !sources.includes(file) && !records.includes(file))).toEqual([])
  })

  it('the only records in the map are the three tracked contract records, in the layer contract', () => {
    const records = recordsOf(map)
    expect(records.map(record => path.posix.basename(record)).sort()).toEqual(['accepted.json', 'factory.json', 'ratchet.json'])
    expect(records.filter(record => map.files[record] !== 'contract')).toEqual([])
    expect(records.filter(record => !tracked(record))).toEqual([])
  })

  it('selectRun over every tracked file takes the full run only for the root configs and the workflows', () => {
    const files = spawnSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.split('\n').filter(file => file !== '')
    const graph = cruise()
    const texts = new Map<string, string>()
    const text = (module: string): string => texts.get(module) ?? texts.set(module, readTest(module)).get(module)!
    const full = files.filter(file => !isCheckPipeline(file) && fullRunReason([file], graph, text, map) !== null)
    expect(full.filter(file => !isRootConfigOrWorkflow(file))).toEqual([])
    expect(files.filter(isRootConfigOrWorkflow).filter(file => !isCheckPipeline(file) && !full.includes(file))).toEqual([])
    expect(full.filter(file => file.startsWith(WORKFLOWS)).length).toBeGreaterThan(0)
    expect(selectRun(['.github/workflows/ci.yml'], graph, text, map).kind).toBe('full')
    expect(selectRun(['scripts/construct/daemon.mjs'], graph, text, map).kind).toBe('layers')
  }, 120_000)

  it('a file entry wins over the folder that holds it', () => {
    expect(layersIn({ files: { 'scripts/core/queue.ts': 'core' }, folders: { 'scripts/bus/': 'bus' } }, 'scripts/core/queue.ts')).toEqual(['core'])
    expect(layersIn({ files: {}, folders: { 'scripts/release/': 'release', 'scripts/release-notes/': 'release-notes' } }, 'scripts/release-notes/render.ts')).toEqual(['release-notes'])
  })

  it('names the bus core and each bus service the way the dependency rules see them', () => {
    const bus = sources.filter(file => BUS_CORE.test(file) || BUS_SERVICE.test(file))
    expect(bus.length).toBeGreaterThan(0)
    for (const file of bus)
      expect([file, map.files[file]]).toEqual([file, BUS_CORE.test(file) ? 'bus-core' : `bus:${BUS_SERVICE.exec(file)![1]}`])
  })
})
