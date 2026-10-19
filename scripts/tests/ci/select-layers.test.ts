import type { Graph } from '../../ci/layers.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUS_CORE as CORE_PATTERN, layerOf, selectRun, BUS_SERVICE as SERVICE_PATTERN } from '../../ci/layers.js'
import { pathsOf } from '../../ci/select.js'

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

  it('a path in no layer of the graph takes the full run', () => {
    expect(selectRun(['docs/index.md'], GRAPH, () => '').kind).toBe('full')
    expect(selectRun(['scripts/bus/unknown.ts'], GRAPH, () => '').kind).toBe('full')
    expect(selectRun([], GRAPH, () => '').kind).toBe('full')
  })

  it('a test that spawns a changed script is selected though it imports nothing', () => {
    const run = layersRun(['scripts/notes/print.ts'], test => test === 'scripts/tests/notes/spawn.test.ts' ? 'tsx scripts/notes/print.ts' : '')
    expect(run.tests).toEqual(['scripts/tests/notes/spawn.test.ts'])
  })

  it('a change in src/ui/lore.ts selects tests/dependency-policy.test.ts, which scans src without importing it', () => {
    const graph: Graph = new Map([
      ['src/ui/lore.ts', []],
      ['tests/dependency-policy.test.ts', []],
    ])
    const run = selectRun(['src/ui/lore.ts'], graph, () => '')
    expect(run).toMatchObject({ kind: 'layers', tests: ['tests/dependency-policy.test.ts'] })
  })

  it('a change outside every scanned tree does not add the scanning tests', () => {
    const graph: Graph = new Map([
      ['scripts/notes/print.ts', []],
      ['tests/dependency-policy.test.ts', []],
    ])
    const run = selectRun(['scripts/notes/print.ts'], graph, () => '')
    expect(run).toMatchObject({ kind: 'layers', tests: [] })
  })
})

describe('the changed paths come from argv, or from NUL-separated stdin under --stdin', () => {
  it('keeps argv paths when --stdin is absent', () => {
    expect(pathsOf(['a.ts', 'b.ts'], () => 'ignored')).toEqual(['a.ts', 'b.ts'])
  })

  it('splits stdin on NUL and drops the empty tail', () => {
    expect(pathsOf(['--stdin'], () => 'src/a.ts\0docs/b md\0')).toEqual(['src/a.ts', 'docs/b md'])
  })

  it('reads no path from an empty stdin', () => {
    expect(pathsOf(['--stdin'], () => '')).toEqual([])
  })
})

const CRUISER_CONFIG = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', '.dependency-cruiser.mjs'), 'utf8')

function configPattern(name: string): RegExp {
  const literal = new RegExp(`const ${name} = '(.*)'`).exec(CRUISER_CONFIG)?.[1]
  if (literal === undefined)
    throw new Error(`${name} is not declared in .dependency-cruiser.mjs`)
  return new RegExp(literal.replaceAll('\\\\', '\\'))
}

const BUS_CORE = configPattern('BUS_CORE')
const BUS_SERVICE = configPattern('BUS_SERVICE')

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
      expect(CORE_PATTERN.test(sample)).toBe(BUS_CORE.test(sample))
      expect(SERVICE_PATTERN.test(sample)).toBe(BUS_SERVICE.test(sample))
    }
  })

  it('names a layer for each sample', () => {
    expect(samples.map(layerOf)).toEqual(['bus-core', 'bus-core', 'bus-core', 'bus-core', 'bus-core', 'bus:merge', 'bus:review', 'bus:ladder', 'bus', 'bus', 'ci'])
  })
})
