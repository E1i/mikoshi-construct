import type { ModuleGraphSpec } from '../../contract/factory/modules.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { carvedOut } from '../../contract/factory/modules.js'
import { BOUNDARY_PREFIX, boundaryNumbers, boundaryReport, renderBoundaryReport, violationLine } from '../../contract/module-graph/boundary.js'
import { buildImportGraph } from '../../contract/module-graph/imports.js'
import { ratchetBreaks, readRatchet } from '../../contract/ratchet.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const REPO_RUN_TIMEOUT = 180_000
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function treeOf(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'module-boundary-'))
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
    alpha: { owns: ['scripts/alpha/**'], contract: ['scripts/alpha/index.ts'], may_use: ['beta'], status: 'decided' },
    beta: { owns: ['scripts/beta/**'], contract: ['scripts/beta/index.ts'], may_use: ['alpha'], status: 'decided' },
    gamma: { owns: ['scripts/gamma/**'], contract: [], may_use: [], status: 'undecided' },
  }),
  composition_roots: ['scripts/main.ts'],
  exclusions: { tests: ['scripts/tests/**'], fixtures: [], templates: [], generated: [], tooling: [] },
}

const LAWFUL = {
  'scripts/alpha/index.ts': 'export const alpha = 1\n',
  'scripts/beta/index.ts': 'export const beta = 1\n',
  'scripts/beta/impl.ts': 'export const impl = 1\n',
  'scripts/gamma/index.ts': 'export const gamma = 1\n',
  'scripts/main.ts': 'import \'./alpha/index.js\'\nimport \'./beta/impl.js\'\nimport \'./gamma/index.js\'\n',
  'scripts/tests/alpha.test.ts': 'import \'../beta/impl.js\'\n',
}

function linesFor(files: Record<string, string>): string[] {
  return boundaryReport(treeOf(files), SPEC, {}).violations.map(violationLine)
}

describe('module graph imports', () => {
  it('counts type-only imports, re-exports, dynamic import() and path aliases', () => {
    const root = treeOf({
      'scripts/a.ts': [
        'import type { B } from \'./b.js\'',
        'export { c } from \'./c.js\'',
        'const d = await import(\'./d.js\')',
        'import { e } from \'@lib/e.js\'',
        'type F = typeof import(\'./f.js\')',
        'import { type G } from \'./g.js\'',
        'import pkg from \'node:path\'',
      ].join('\n'),
      ...Object.fromEntries(['b', 'c', 'd', 'f', 'g'].map(name => [`scripts/${name}.ts`, 'export {}\n'])),
      'scripts/lib/e.ts': 'export {}\n',
    })
    const files = ['scripts/a.ts', 'scripts/b.ts', 'scripts/c.ts', 'scripts/d.ts', 'scripts/f.ts', 'scripts/g.ts', 'scripts/lib/e.ts']

    expect(buildImportGraph(root, files, ['scripts/a.ts'], { '@lib/*': ['scripts/lib/*'] })).toEqual([
      { from: 'scripts/a.ts', to: 'scripts/b.ts', kinds: ['type'] },
      { from: 'scripts/a.ts', to: 'scripts/c.ts', kinds: ['re-export'] },
      { from: 'scripts/a.ts', to: 'scripts/d.ts', kinds: ['dynamic'] },
      { from: 'scripts/a.ts', to: 'scripts/f.ts', kinds: ['type'] },
      { from: 'scripts/a.ts', to: 'scripts/g.ts', kinds: ['type'] },
      { from: 'scripts/a.ts', to: 'scripts/lib/e.ts', kinds: ['import'] },
    ])
  })
})

describe('module graph boundary (law 3)', () => {
  it('an import into the contract of a module in may_use is lawful, and roots and tests are outside the law', () => {
    expect(linesFor({ ...LAWFUL, 'scripts/alpha/use.ts': 'import { beta } from \'../beta/index.js\'\n' })).toEqual([])
  })

  it('an import into the impl of another module is red', () => {
    expect(linesFor({ ...LAWFUL, 'scripts/alpha/use.ts': 'import type { impl } from \'../beta/impl.js\'\n' }))
      .toEqual(['scripts/alpha/use.ts -> scripts/beta/impl.ts: outside-contract'])
  })

  it('an import into a module that is not in may_use is red', () => {
    const narrow: ModuleGraphSpec = { ...SPEC, modules: { ...SPEC.modules, alpha: { ...SPEC.modules.alpha!, may_use: [] } } }

    expect(boundaryReport(treeOf({ ...LAWFUL, 'scripts/alpha/use.ts': 'export { beta } from \'../beta/index.js\'\n' }), narrow, {}).violations.map(violationLine))
      .toEqual(['scripts/alpha/use.ts -> scripts/beta/index.ts: not-in-may-use'])
  })

  it('an import into an undecided module is red', () => {
    expect(linesFor({ ...LAWFUL, 'scripts/alpha/use.ts': 'const gamma = await import(\'../gamma/index.js\')\n' }))
      .toEqual(['scripts/alpha/use.ts -> scripts/gamma/index.ts: into-undecided, not-in-may-use, outside-contract'])
  })

  it('an import out of an undecided module is red', () => {
    expect(linesFor({ ...LAWFUL, 'scripts/gamma/use.ts': 'import \'../alpha/index.js\'\n' }))
      .toEqual(['scripts/gamma/use.ts -> scripts/alpha/index.ts: from-undecided, not-in-may-use'])
  })

  it('an import from a module into a composition root is red', () => {
    expect(linesFor({ ...LAWFUL, 'scripts/alpha/use.ts': 'import \'../main.js\'\n' }))
      .toEqual(['scripts/alpha/use.ts -> scripts/main.ts: into-composition-root'])
  })
})

describe('module graph reproducibility (law 6)', () => {
  it('a cycle between modules is one SCC', () => {
    const report = boundaryReport(treeOf({
      ...LAWFUL,
      'scripts/alpha/index.ts': 'import \'../beta/index.js\'\n',
      'scripts/beta/index.ts': 'import \'../alpha/index.js\'\n',
    }), SPEC, {})

    expect(report.scc).toEqual([['alpha', 'beta']])
    expect(report.violations).toEqual([])
  })

  it('two runs on one commit give byte-identical graph, violations and SCC', { timeout: REPO_RUN_TIMEOUT }, () => {
    const [first, second] = [boundaryReport(REPO_ROOT), boundaryReport(REPO_ROOT)]

    expect(first.graph.length).toBeGreaterThan(0)
    expect(renderBoundaryReport(second)).toBe(renderBoundaryReport(first))
  })
})

describe('module graph baseline (law 5)', () => {
  it('a new violation row is red and a vanished one must leave the ledger', () => {
    const recorded = { [`${BOUNDARY_PREFIX}alpha->beta`]: 1 }

    expect(ratchetBreaks(recorded, { ...recorded, [`${BOUNDARY_PREFIX}alpha->gamma`]: 1 })).toEqual([expect.stringContaining(`${BOUNDARY_PREFIX}alpha->gamma grew from 0 to 1`)])
    expect(ratchetBreaks(recorded, {})).toEqual([expect.stringContaining(`${BOUNDARY_PREFIX}alpha->beta went down from 1 to 0`)])
  })

  it('the violation ledger does not grow and holds no vanished row', { timeout: REPO_RUN_TIMEOUT }, () => {
    const ledger = Object.fromEntries(Object.entries(readRatchet(REPO_ROOT)).filter(([key]) => key.startsWith(BOUNDARY_PREFIX)))

    expect(ratchetBreaks(ledger, boundaryNumbers(boundaryReport(REPO_ROOT).violations))).toEqual([])
  })
})
