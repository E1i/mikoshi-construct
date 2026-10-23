import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUS_CORE, BUS_SERVICE } from '../../ci/layers.js'
import { layersIn, readLayerMap } from '../../core/layer-map.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const TEST_ROOT = 'scripts/tests/'

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

  it('every file entry of the map names a tracked source file', () => {
    expect(Object.keys(map.files).filter(file => !sources.includes(file))).toEqual([])
  })

  it('a file entry wins over the folder that holds it', () => {
    expect(layersIn({ files: { 'scripts/bus/queue.ts': 'core' }, folders: { 'scripts/bus/': 'bus' } }, 'scripts/bus/queue.ts')).toEqual(['core'])
    expect(layersIn({ files: {}, folders: { 'scripts/release/': 'release', 'scripts/release-notes/': 'release-notes' } }, 'scripts/release-notes/render.ts')).toEqual(['release-notes'])
  })

  it('names the bus core and each bus service the way the dependency rules see them', () => {
    const bus = sources.filter(file => BUS_CORE.test(file) || BUS_SERVICE.test(file))
    expect(bus.length).toBeGreaterThan(0)
    for (const file of bus)
      expect([file, map.files[file]]).toEqual([file, BUS_CORE.test(file) ? 'bus-core' : `bus:${BUS_SERVICE.exec(file)![1]}`])
  })
})
