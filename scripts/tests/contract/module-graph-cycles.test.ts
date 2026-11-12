import type { ModuleGraphSpec } from '../../contract/factory/modules.js'
import type { ImportEdge } from '../../contract/module-graph/imports.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { carvedOut, MODULE_GRAPH } from '../../contract/factory/modules.js'
import { boundaryReport } from '../../contract/module-graph/boundary.js'
import { cyclesReport, mayUseCycleLine, mayUseCycles, moduleGraphSummary, sourceCycleLine, sourceCycles } from '../../contract/module-graph/cycles.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const REPO_RUN_TIMEOUT = 180_000

function moduleOf(name: string, may_use: string[] = []): ModuleGraphSpec['modules'][string] {
  return { owns: [`scripts/${name}/**`], contract: [`scripts/${name}/index.ts`], may_use, status: 'decided' }
}

function specOf(mayUse: Record<string, string[]>): ModuleGraphSpec {
  return {
    modules: carvedOut(Object.fromEntries(Object.entries(mayUse).map(([name, uses]) => [name, moduleOf(name, uses)]))),
    composition_roots: [],
    exclusions: { tests: [], fixtures: [], templates: [], generated: [], tooling: [] },
  }
}

function edge(from: string, to: string): ImportEdge {
  return { from, to, kinds: ['import'] }
}

describe('module graph cycles (law 4)', () => {
  it('a may_use graph without a cycle is a DAG', () => {
    expect(mayUseCycles(specOf({ alpha: ['beta'], beta: ['gamma'], gamma: [] }))).toEqual([])
  })

  it('a cycle in may_use is red', () => {
    const cycles = mayUseCycles(specOf({ alpha: ['beta'], beta: ['gamma'], gamma: ['alpha'], delta: ['alpha'] }))

    expect(cycles).toEqual([['alpha', 'beta', 'gamma']])
    expect(cycles.map(mayUseCycleLine)).toEqual(['may_use cycle: alpha, beta, gamma'])
    expect(mayUseCycles(specOf({ alpha: ['alpha'] }))).toEqual([['alpha']])
  })

  it('each source SCC is reported with one example chain apart from the may_use graph', () => {
    const spec = specOf({ alpha: [], beta: ['alpha'], gamma: [], delta: ['gamma'], omega: [] })
    const graph = [
      edge('scripts/alpha/a.ts', 'scripts/beta/index.ts'),
      edge('scripts/alpha/b.ts', 'scripts/beta/index.ts'),
      edge('scripts/beta/index.ts', 'scripts/alpha/index.ts'),
      edge('scripts/gamma/index.ts', 'scripts/delta/x.ts'),
      edge('scripts/delta/x.ts', 'scripts/omega/index.ts'),
      edge('scripts/omega/index.ts', 'scripts/gamma/index.ts'),
      edge('scripts/omega/index.ts', 'scripts/delta/index.ts'),
      edge('scripts/stray.ts', 'scripts/alpha/index.ts'),
    ]

    const report = cyclesReport(spec, graph)

    expect(report.mayUse).toEqual([])
    expect(report.source.map(({ scc }) => scc)).toEqual([['alpha', 'beta'], ['delta', 'gamma', 'omega']])
    expect(report.source.map(sourceCycleLine)).toEqual([
      'source SCC [alpha, beta]: alpha (scripts/alpha/a.ts -> scripts/beta/index.ts) -> beta (scripts/beta/index.ts -> scripts/alpha/index.ts) -> alpha',
      'source SCC [delta, gamma, omega]: delta (scripts/delta/x.ts -> scripts/omega/index.ts) -> omega (scripts/omega/index.ts -> scripts/delta/index.ts) -> delta',
    ])
    expect(sourceCycles(spec, [...graph].reverse())).toEqual(report.source)
  })

  it('a source cycle does not make may_use red, nor a may_use cycle a source SCC', () => {
    const spec = specOf({ alpha: ['beta'], beta: ['alpha'] })

    expect(cyclesReport(spec, [])).toEqual({ mayUse: [['alpha', 'beta']], source: [] })
    expect(cyclesReport(specOf({ alpha: [], beta: [] }), [edge('scripts/alpha/index.ts', 'scripts/beta/index.ts'), edge('scripts/beta/index.ts', 'scripts/alpha/index.ts')]).mayUse).toEqual([])
  })

  it('the factory may_use graph is a DAG, and every source SCC carries a closed chain', { timeout: REPO_RUN_TIMEOUT }, () => {
    const summary = moduleGraphSummary(MODULE_GRAPH, boundaryReport(REPO_ROOT))

    expect(summary.cycles.mayUse.map(mayUseCycleLine)).toEqual([])
    expect(summary.modules).toBe(Object.keys(MODULE_GRAPH.modules).length)
    for (const { scc, chain } of summary.cycles.source) {
      expect(chain.length).toBeGreaterThan(1)
      expect(chain[0]!.from).toBe(scc[0])
      expect(chain.at(-1)!.to).toBe(scc[0])
      expect(chain.every(({ from, to }) => scc.includes(from) && scc.includes(to))).toBe(true)
    }
  })
})
