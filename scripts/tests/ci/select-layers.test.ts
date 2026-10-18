import type { Graph } from '../../ci/layers.js'
import { describe, expect, it } from 'vitest'
import { BUS_CORE, BUS_SERVICE } from '../../../.dependency-cruiser.mjs'
import { BUS_CORE as CORE_PATTERN, layerOf, mutationMatrix, selectRun, BUS_SERVICE as SERVICE_PATTERN } from '../../ci/layers.js'

const GRAPH: Graph = new Map([
  ['scripts/bus/db.ts', []],
  ['scripts/bus/merge-worker.ts', ['scripts/bus/db.ts']],
  ['scripts/bus/review-worker.ts', ['scripts/bus/db.ts']],
  ['scripts/ghosts/launch.ts', ['scripts/bus/db.ts']],
  ['scripts/notes/print.ts', []],
  ['scripts/tests/bus/merge-worker.test.ts', ['scripts/bus/merge-worker.ts']],
  ['scripts/tests/bus/review-worker.test.ts', ['scripts/bus/review-worker.ts']],
  ['scripts/tests/ghosts/launch.test.ts', ['scripts/ghosts/launch.ts']],
  ['scripts/tests/notes/spawn.test.ts', []],
])

function layersRun(changed: string[], testText: (test: string) => string = () => '') {
  const run = selectRun(changed, GRAPH, testText)
  if (run.kind !== 'layers')
    throw new Error(`expected a layer run, got: ${run.why}`)
  return run
}

describe('the checks a change reaches follow the layers of the dependency graph', () => {
  it('a change in a service runs that service\'s layer and not the others', () => {
    const run = layersRun(['scripts/bus/merge-worker.ts'])
    expect(run.layers).toEqual(['bus:merge'])
    expect(run.tests).toEqual(['scripts/tests/bus/merge-worker.test.ts'])
  })

  it('a change in the core runs the core and every dependent layer', () => {
    const run = layersRun(['scripts/bus/db.ts'])
    expect(run.layers).toEqual(['bus-core', 'bus:merge', 'bus:review', 'ghosts'])
    expect(run.tests).toEqual([
      'scripts/tests/bus/merge-worker.test.ts',
      'scripts/tests/bus/review-worker.test.ts',
      'scripts/tests/ghosts/launch.test.ts',
    ])
  })

  it('a catalog mutation in a touched layer is killed by its own test', () => {
    const run = layersRun(['scripts/bus/merge-worker.ts'])
    const matrix = mutationMatrix(run, [
      { id: 'M1', file: 'scripts/bus/merge-worker.ts', killedBy: 'scripts/tests/bus/merge-worker.test.ts' },
      { id: 'M2', file: 'scripts/bus/review-worker.ts', killedBy: 'scripts/tests/bus/review-worker.test.ts' },
    ])
    expect(matrix).toEqual([{ id: 'M1', layer: 'bus:merge', killedBy: 'scripts/tests/bus/merge-worker.test.ts', runs: true }])
  })

  it('a path in no layer of the graph takes the full run', () => {
    expect(selectRun(['docs/index.md'], GRAPH, () => '').kind).toBe('full')
    expect(selectRun(['scripts/bus/unknown.ts'], GRAPH, () => '').kind).toBe('full')
    expect(selectRun([], GRAPH, () => '').kind).toBe('full')
  })

  it('a test that spawns a changed script is selected though it imports nothing', () => {
    const run = layersRun(['scripts/notes/print.ts'], test => test === 'scripts/tests/notes/spawn.test.ts' ? 'tsx scripts/notes/print.ts' : '')
    expect(run.tests).toEqual(['scripts/tests/notes/spawn.test.ts'])
  })

  it('a mutation whose killing test is not selected is marked as not run', () => {
    const run = layersRun(['scripts/bus/merge-worker.ts'])
    expect(mutationMatrix(run, [{ id: 'M3', file: 'scripts/bus/merge-worker.ts', killedBy: 'scripts/tests/bus/other.test.ts' }])[0].runs).toBe(false)
  })
})

describe('the layer patterns of the selector are the ones of the dependency-cruiser config', () => {
  const samples = [
    'scripts/bus/db.ts',
    'scripts/bus/reducer.ts',
    'scripts/bus/sqlite.ts',
    'scripts/bus/stored.ts',
    'scripts/bus/identifiers.ts',
    'scripts/bus/merge-worker.ts',
    'scripts/bus/review-executor.ts',
    'scripts/bus/ladder-starter.ts',
    'scripts/bus/check-catalog.ts',
    'scripts/bus/review-bg.ts',
    'scripts/ci/layers.ts',
  ]

  it('matches the same files as the config for the core and for the services', () => {
    for (const sample of samples) {
      expect(CORE_PATTERN.test(sample)).toBe(new RegExp(BUS_CORE).test(sample))
      expect(SERVICE_PATTERN.test(sample)).toBe(new RegExp(BUS_SERVICE).test(sample))
    }
  })

  it('names a layer for each sample', () => {
    expect(samples.map(layerOf)).toEqual(['bus-core', 'bus-core', 'bus-core', 'bus-core', 'bus-core', 'bus:merge', 'bus:review', 'bus:ladder', 'bus', 'bus', 'ci'])
  })
})
