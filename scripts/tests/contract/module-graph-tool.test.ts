import type { ModuleGraphSpec } from '../../contract/factory/modules.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { carvedOut, MODULE_GRAPH, MODULE_STATUSES } from '../../contract/factory/modules.js'
import { BOUNDARY_PREFIX, boundaryNumbers, boundaryReport, graphModules, violationLine } from '../../contract/module-graph/boundary.js'
import { mayUseCycles, moduleGraphSummary } from '../../contract/module-graph/cycles.js'
import { faultLine, ownerOf, ownershipFaults } from '../../contract/module-graph/ownership.js'

const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function treeOf(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'module-tool-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

const SPEC: ModuleGraphSpec = {
  modules: carvedOut({
    alpha: { owns: ['scripts/alpha/**'], contract: ['scripts/alpha/index.ts'], may_use: [], status: 'decided' },
    gamma: { owns: ['scripts/gamma/**'], contract: [], may_use: [], status: 'undecided' },
    gen: { owns: ['scripts/gen/**'], contract: [], may_use: [], status: 'tool' },
  }),
  composition_roots: ['scripts/main.ts'],
  composition_imports: {},
  exclusions: { tests: [], fixtures: [], templates: [], generated: [], tooling: [] },
}

const BASE = {
  'scripts/alpha/index.ts': 'export const alpha = 1\n',
  'scripts/alpha/impl.ts': 'export const impl = 1\n',
  'scripts/gamma/index.ts': 'export const gamma = 1\n',
  'scripts/gen/index.ts': 'export const gen = 1\n',
  'scripts/main.ts': 'export const main = 1\n',
}

const SEES_EVERY_MODULE = {
  'scripts/gen/read.ts': [
    'import \'../alpha/impl.js\'',
    'import \'../gamma/index.js\'',
    'import \'../main.js\'',
  ].join('\n'),
}

describe('module graph: a tool', () => {
  it('a tool sees every module and stays out of the architecture graph', () => {
    const report = boundaryReport(treeOf({ ...BASE, ...SEES_EVERY_MODULE, 'scripts/alpha/index.ts': 'import \'../gen/index.js\'\n' }), SPEC, {})

    expect(report.graph.filter(({ from }) => from === 'scripts/gen/read.ts').map(({ to }) => to)).toEqual(['scripts/alpha/impl.ts', 'scripts/gamma/index.ts', 'scripts/main.ts'])
    expect(report.violations.filter(({ fromModule }) => fromModule === 'gen')).toEqual([])
    expect(report.scc).toEqual([])
    expect(graphModules(SPEC)).toEqual(['alpha', 'gamma'])
    expect(mayUseCycles(SPEC)).toEqual([])
    expect(moduleGraphSummary(SPEC, report)).toMatchObject({ modules: 2, tools: 1, violatingImports: 1 })
  })

  it('an import into a tool is a violation', () => {
    const report = boundaryReport(treeOf({
      ...BASE,
      'scripts/alpha/use.ts': 'import \'../gen/index.js\'\n',
      'scripts/gamma/use.ts': 'import type { gen } from \'../gen/index.js\'\n',
    }), SPEC, {})

    expect(report.violations.map(violationLine)).toEqual([
      'scripts/alpha/use.ts -> scripts/gen/index.ts: into-tool',
      'scripts/gamma/use.ts -> scripts/gen/index.ts: into-tool',
    ])
    expect(boundaryNumbers(report.violations)).toEqual({ [`${BOUNDARY_PREFIX}alpha->gen`]: 1, [`${BOUNDARY_PREFIX}gamma->gen`]: 1 })
  })

  it('no module names a tool in may_use', () => {
    const naming: ModuleGraphSpec = { ...SPEC, modules: { ...SPEC.modules, alpha: { ...SPEC.modules.alpha!, may_use: ['gen'] } } }

    expect(ownershipFaults(naming, []).filter(({ kind }) => kind === 'unknown-may-use').map(faultLine)).toEqual(['alpha: may_use names gen, which is not another module'])
  })
})

describe('the factory contract generator is a tool', () => {
  const RUNTIME_CONSUMED = ['scripts/contract/contours.ts']

  it('the generator is a tool and the files with runtime importers stay undecided in factory-contract', () => {
    expect(MODULE_STATUSES).toContain('tool')
    expect(MODULE_GRAPH.modules['contract-generator']!.status).toBe('tool')
    expect(MODULE_GRAPH.modules['factory-contract']).toMatchObject({ owns: RUNTIME_CONSUMED, contract: [], may_use: [], status: 'undecided' })
    expect(ownerOf(MODULE_GRAPH, 'scripts/contract/factory/modules.ts')).toEqual(['contract-generator'])
    expect(ownerOf(MODULE_GRAPH, 'scripts/contract/module-graph/boundary.ts')).toEqual(['contract-generator'])
    expect(RUNTIME_CONSUMED.map(file => ownerOf(MODULE_GRAPH, file))).toEqual([['factory-contract']])
  })

  it('every tool of the factory carries no contract and no may_use', () => {
    const tools = Object.entries(MODULE_GRAPH.modules).filter(([, spec]) => spec.status === 'tool')

    expect(tools.filter(([, spec]) => spec.contract.length > 0 || spec.may_use.length > 0).map(([id]) => id)).toEqual([])
  })
})
