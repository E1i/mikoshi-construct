import type { ModuleGraphSpec, ModuleSpec } from '../../contract/factory/modules.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { carvedOut } from '../../contract/factory/modules.js'
import { VIOLATION_REASONS } from '../../contract/module-graph/boundary.js'
import { REASONS_NOTE, reasonTable, renderReport, REPORT_VERSION, repositoryReport, specVersion } from '../../contract/module-graph/report.js'

const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function treeOf(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'module-report-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function decided(name: string, may_use: string[] = []): ModuleSpec {
  return { owns: [`scripts/${name}/**`], contract: [`scripts/${name}/index.ts`], may_use, status: 'decided' }
}

function specOf(modules: Record<string, ModuleSpec>): ModuleGraphSpec {
  return {
    modules: carvedOut(modules),
    composition_roots: ['scripts/main.ts'],
    exclusions: { tests: ['scripts/tests/**'], fixtures: [], templates: [], generated: [], tooling: [] },
  }
}

function moduleFiles(name: string, imports: string[] = []): Record<string, string> {
  return {
    [`scripts/${name}/index.ts`]: `${imports.map(target => `import '../${target}.js'\n`).join('')}export const ${name} = 1\n`,
    [`scripts/${name}/impl.ts`]: `export const ${name}Impl = 1\n`,
  }
}

const SIMPLE_SPEC = specOf({ alpha: decided('alpha', ['beta']), beta: decided('beta') })
const SIMPLE = { ...moduleFiles('alpha', ['beta/index']), ...moduleFiles('beta'), 'scripts/main.ts': 'import \'./alpha/index.js\'\n' }

const PAIRS_SPEC = specOf({ a: decided('a', ['b']), b: decided('b', ['a']), c: decided('c', ['d']), d: decided('d', ['c']) })
const PAIRS = { ...moduleFiles('a', ['b/index']), ...moduleFiles('b', ['a/index']), ...moduleFiles('c', ['d/index']), ...moduleFiles('d', ['c/index']) }

const RING_SPEC = specOf({ m1: decided('m1', ['m2']), m2: decided('m2', ['m3']), m3: decided('m3', ['m4']), m4: decided('m4', ['m1']) })
const RING = { ...moduleFiles('m1', ['m2/index']), ...moduleFiles('m2', ['m3/index']), ...moduleFiles('m3', ['m4/index']), ...moduleFiles('m4', ['m1/index']) }

function reversed(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).reverse())
}

describe('the module graph report', () => {
  it('two runs on one commit are byte-identical', () => {
    const files = { ...PAIRS, 'scripts/a/leak.ts': 'import \'../c/impl.js\'\nimport \'../b/impl.js\'\n' }
    const first = treeOf(files)
    const second = treeOf(reversed(files))

    const once = renderReport(repositoryReport(first, PAIRS_SPEC))
    expect(renderReport(repositoryReport(first, PAIRS_SPEC))).toBe(once)
    expect(renderReport(repositoryReport(second, PAIRS_SPEC))).toBe(once)
    expect(once).not.toContain(first)
    expect(once).not.toContain(tmpdir())
    expect(once).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    const report = repositoryReport(first, PAIRS_SPEC)
    expect(report.files.map(({ file }) => file)).toEqual([...report.files.map(({ file }) => file)].sort())
    expect(report.graph.imports.map(({ from, to }) => `${from} ${to}`)).toEqual(report.graph.imports.map(({ from, to }) => `${from} ${to}`).sort())
    expect(report.violations.map(({ from, to }) => `${from} ${to}`)).toEqual(['scripts/a/leak.ts scripts/b/impl.ts', 'scripts/a/leak.ts scripts/c/impl.ts'])
  })

  it('carries the report version and a spec version that follows the spec, not the order its keys were written in', () => {
    const report = repositoryReport(treeOf(SIMPLE), SIMPLE_SPEC)
    const shuffled = specOf({ beta: decided('beta'), alpha: decided('alpha', ['beta']) })

    expect(report.reportVersion).toBe(REPORT_VERSION)
    expect(report.spec.version).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(specVersion(shuffled)).toBe(report.spec.version)
    expect(specVersion(specOf({ alpha: decided('alpha'), beta: decided('beta') }))).not.toBe(report.spec.version)
  })

  it('a simple allowed graph has its edges and no violation, component or chain', () => {
    const report = repositoryReport(treeOf(SIMPLE), SIMPLE_SPEC)

    expect(report.graph.modules).toEqual([{ from: 'alpha', to: 'beta', imports: 1 }])
    expect(report.violations).toEqual([])
    expect(report.components).toEqual([])
    expect(report.chains).toEqual([])
    expect(report.statistics).toEqual({ files: 5, modules: 2, tools: 0, imports: 2, moduleEdges: 1, violatingImports: 0, components: 0, mayUseCycles: 0 })
    expect(report.files).toContainEqual({ file: 'scripts/main.ts', holder: 'composition root' })
  })

  it('an import into a module\'s internals is a violation with the reason outside-contract', () => {
    const report = repositoryReport(treeOf({ ...SIMPLE, 'scripts/alpha/deep.ts': 'import \'../beta/impl.js\'\n' }), SIMPLE_SPEC)

    expect(report.violations).toEqual([{ from: 'scripts/alpha/deep.ts', to: 'scripts/beta/impl.ts', fromModule: 'alpha', toHolder: 'beta', reasons: ['outside-contract'] }])
    expect(report.graph.modules).toEqual([{ from: 'alpha', to: 'beta', imports: 2 }])
  })

  it('two independent cycles are reported as two components', () => {
    const report = repositoryReport(treeOf(PAIRS), PAIRS_SPEC)

    expect(report.components).toEqual([['a', 'b'], ['c', 'd']])
    expect(report.chains.map(({ scc, chain }) => [scc, chain.map(({ from, to }) => `${from}->${to}`)])).toEqual([
      [['a', 'b'], ['a->b', 'b->a']],
      [['c', 'd'], ['c->d', 'd->c']],
    ])
    expect(report.mayUseCycles).toEqual([['a', 'b'], ['c', 'd']])
    expect(report.statistics.components).toBe(2)
  })

  it('one large component holds every module of the ring and its chain walks all of them', () => {
    const report = repositoryReport(treeOf(RING), RING_SPEC)

    expect(report.components).toEqual([['m1', 'm2', 'm3', 'm4']])
    expect(report.chains[0]!.chain.map(({ from, to, import: { from: file, to: target } }) => `${from}->${to} ${file}->${target}`)).toEqual([
      'm1->m2 scripts/m1/index.ts->scripts/m2/index.ts',
      'm2->m3 scripts/m2/index.ts->scripts/m3/index.ts',
      'm3->m4 scripts/m3/index.ts->scripts/m4/index.ts',
      'm4->m1 scripts/m4/index.ts->scripts/m1/index.ts',
    ])
  })

  it('an undecided module named in may_use does not become an allowed dependency', () => {
    const spec = specOf({ alpha: decided('alpha', ['gamma']), gamma: { ...decided('gamma'), status: 'undecided' } })
    const report = repositoryReport(treeOf({ ...moduleFiles('alpha', ['gamma/index']), ...moduleFiles('gamma') }), spec)

    expect(report.violations.map(({ to, reasons }) => [to, reasons])).toEqual([['scripts/gamma/index.ts', ['into-undecided']]])
    expect(report.graph.modules).toEqual([{ from: 'alpha', to: 'gamma', imports: 1 }])
  })

  it('a tool sees every module and is not in the graph', () => {
    const spec = specOf({ ...SIMPLE_SPEC.modules, gen: { owns: ['scripts/gen/**'], contract: [], may_use: [], status: 'tool' } })
    const report = repositoryReport(treeOf({ ...SIMPLE, 'scripts/gen/read.ts': 'import \'../alpha/impl.js\'\nimport \'../beta/impl.js\'\nimport \'../main.js\'\n' }), spec)

    expect(report.graph.imports.filter(({ from }) => from === 'scripts/gen/read.ts').map(({ to }) => to)).toEqual(['scripts/alpha/impl.ts', 'scripts/beta/impl.ts', 'scripts/main.ts'])
    expect(report.graph.modules).toEqual([{ from: 'alpha', to: 'beta', imports: 1 }])
    expect(report.violations).toEqual([])
    expect(report.components).toEqual([])
    expect(report.modules.find(({ id }) => id === 'gen')).toEqual({ id: 'gen', status: 'tool', inGraph: false, files: 1 })
    expect(report.statistics).toMatchObject({ modules: 2, tools: 1 })
  })

  it('an import is counted once and its reasons are listed apart', () => {
    const spec = specOf({ alpha: { ...decided('alpha'), status: 'undecided' }, gamma: { ...decided('gamma'), status: 'undecided' } })
    const report = repositoryReport(treeOf({ ...moduleFiles('alpha'), ...moduleFiles('gamma'), 'scripts/alpha/deep.ts': 'import \'../gamma/impl.js\'\nimport type { gammaImpl } from \'../gamma/impl.js\'\n' }), spec)

    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]!.reasons).toEqual(['from-undecided', 'into-undecided', 'not-in-may-use', 'outside-contract'])
    expect(report.statistics.violatingImports).toBe(1)
    expect(report.reasons.note).toBe(REASONS_NOTE)
    expect(report.reasons.counts).toMatchObject({ 'from-undecided': 1, 'into-undecided': 1, 'not-in-may-use': 1, 'outside-contract': 1 })
    expect(Object.values(report.reasons.counts).reduce((sum, count) => sum + count, 0)).toBe(4)
    expect(Object.keys(report.reasons.counts)).toEqual([...VIOLATION_REASONS])
  })

  it('a reason repeated on one import counts once in its table', () => {
    expect(reasonTable([{ from: 'a', to: 'b', fromModule: 'a', toHolder: 'b', reasons: ['into-tool', 'into-tool'] }]).counts['into-tool']).toBe(1)
  })
})
