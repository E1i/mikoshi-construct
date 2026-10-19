import type { Graph } from '../../ci/layers.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUS_CORE as CORE_PATTERN, layerOf, selectRun, BUS_SERVICE as SERVICE_PATTERN, windowGate } from '../../ci/layers.js'
import { changedPathsOf, outputLines, pathsOf, reportedRun, runSummary, windowLines } from '../../ci/select.js'

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

  it('a change to the test infrastructure every test runs under takes the full run', () => {
    const graph: Graph = new Map([...GRAPH, ['scripts/scratch/vitest-bus.ts', []], ['scripts/ci/shard.ts', []]])
    for (const file of ['vitest.config.ts', 'vitest-workspace.ts', 'scripts/scratch/vitest-setup.ts', 'scripts/scratch/vitest-bus.ts', 'scripts/ci/shard.ts', 'scripts/ci/test-weights.json'])
      expect(selectRun([file, 'scripts/bus/merge-worker.ts'], graph, () => '').kind).toBe('full')
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

  it('a change in src/failure.ts selects tests/cli-exit-codes.test.ts', () => {
    const graph: Graph = new Map([
      ['src/failure.ts', []],
      ['src/program.ts', ['src/failure.ts']],
      ['src/cli.ts', ['src/program.ts']],
      ['tests/cli-process.ts', []],
      ['tests/cli-exit-codes.test.ts', ['tests/cli-process.ts']],
      ['tests/unrelated.test.ts', []],
    ])
    const text = (file: string) => file === 'tests/cli-process.ts' ? 'spawn(node, [\'src/cli.ts\'])' : ''
    const run = selectRun(['src/failure.ts'], graph, text)
    expect(run).toMatchObject({ kind: 'layers', tests: ['tests/cli-exit-codes.test.ts'] })
  })

  it('a change in src/ui/lore.ts selects tests/delivery-boundary.test.ts, which builds the bundle from the tsup config', () => {
    const graph: Graph = new Map([
      ['src/ui/lore.ts', []],
      ['tests/delivery-boundary.test.ts', []],
    ])
    expect(selectRun(['src/ui/lore.ts'], graph, () => '')).toMatchObject({ kind: 'layers', tests: ['tests/delivery-boundary.test.ts'] })
  })

  it('a change in scripts/ghosts/launch.ts selects scripts/tests/shredder/owner-merges.test.ts, which lists the directory', () => {
    const graph: Graph = new Map([
      ['scripts/ghosts/launch.ts', []],
      ['scripts/tests/shredder/owner-merges.test.ts', []],
    ])
    expect(selectRun(['scripts/ghosts/launch.ts'], graph, () => '')).toMatchObject({ kind: 'layers', tests: ['scripts/tests/shredder/owner-merges.test.ts'] })
  })

  it('a test that names a changed script only by its file name is selected', () => {
    const run = layersRun(['scripts/notes/print.ts'], test => test === 'scripts/tests/notes/spawn.test.ts' ? 'tsx print.ts' : '')
    expect(run.tests).toEqual(['scripts/tests/notes/spawn.test.ts'])
  })

  it('a change to only a test file selects that test', () => {
    const run = layersRun(['scripts/tests/bus/merge-worker.test.ts'])
    expect(run.tests).toEqual(['scripts/tests/bus/merge-worker.test.ts'])
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

describe('the window gate of D-194 takes the CI selection by layers', () => {
  const graph: Graph = new Map([
    ...GRAPH,
    ['tests/package-scripts.ts', []],
    ['tests/contributing-scripts.test.ts', ['tests/package-scripts.ts']],
    ['tests/harness-membership.test.ts', ['tests/package-scripts.ts']],
  ])

  it('the window gate for a change to a package.json script selects tests/contributing-scripts.test.ts and tests/harness-membership.test.ts', () => {
    expect(windowGate(['package.json'], graph, () => '')).toEqual({ kind: 'layers', layers: [], tests: ['tests/contributing-scripts.test.ts', 'tests/harness-membership.test.ts'] })
    expect(selectRun(['package.json'], graph, () => '').kind).toBe('full')
  })

  it('the window gate adds the package.json readers to the layers the rest of the change reaches', () => {
    expect(windowGate(['package.json', 'scripts/bus/merge-worker.ts'], graph, () => '')).toEqual({
      kind: 'layers',
      layers: ['bus:merge'],
      tests: ['scripts/tests/bus/merge-worker.test.ts', 'tests/contributing-scripts.test.ts', 'tests/harness-membership.test.ts'],
    })
  })

  it('the window gate takes the full run when the rest of a package.json change reaches no layer', () => {
    const run = windowGate(['package.json', 'docs/index.md'], graph, () => '')
    expect(run).toEqual(selectRun(['docs/index.md'], graph, () => ''))
    expect(run.kind).toBe('full')
  })

  it('the window gate is the CI selection for a change without package.json', () => {
    for (const changed of [['scripts/bus/db.ts'], ['docs/index.md'], []])
      expect(windowGate(changed, graph, () => '')).toEqual(selectRun(changed, graph, () => ''))
  })

  it('the window gate prints the vitest command of its tests, or says there is none', () => {
    expect(windowLines({ kind: 'layers', layers: ['bus:merge'], tests: ['a.test.ts', 'b.test.ts'] })).toContain('pnpm exec vitest run a.test.ts b.test.ts')
    expect(windowLines({ kind: 'full', why: 'docs/index.md belongs to no layer of the dependency graph' })).not.toContain('vitest run')
  })

  it('the changed paths of a tree are the diff against the merge base and the untracked files, each once', () => {
    expect(changedPathsOf('a.ts\nb.ts\n', 'b.ts\nc.ts\n')).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(changedPathsOf('', '')).toEqual([])
  })
})

describe('the lines written for the workflow are the contract with ci.yml', () => {
  it('gives the tests of a layer run separated by spaces', () => {
    expect(outputLines({ kind: 'layers', layers: ['src'], tests: ['a', 'b'] })).toBe('full=false\ntests=a b\n')
  })

  it('gives no tests for a full run', () => {
    expect(outputLines({ kind: 'full', why: 'no changed path was given' })).toBe('full=true\ntests=\n')
  })

  it('an empty selection is reported as a full run', () => {
    const run = reportedRun({ kind: 'layers', layers: ['notes'], tests: [] })
    expect(outputLines(run)).toBe('full=true\ntests=\n')
    expect(runSummary(run)).toMatch(/^Full run: /)
    const selected = { kind: 'layers' as const, layers: ['src'], tests: ['a'] }
    expect(reportedRun(selected)).toBe(selected)
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
