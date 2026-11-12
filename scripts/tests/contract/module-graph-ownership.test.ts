import type { ModuleGraphSpec } from '../../contract/factory/modules.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { CARVED_OUT, carvedOut, heldBy, MODULE_GRAPH, modulesSection } from '../../contract/factory/modules.js'
import { faultLine, ownerOf, ownershipFaults, sourceFiles } from '../../contract/module-graph/ownership.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const PLANTED = 'scripts/planted/stray.ts'

const SMALL: ModuleGraphSpec = {
  modules: carvedOut({
    alpha: { owns: ['scripts/alpha/**'], contract: ['scripts/alpha/index.ts'], may_use: ['beta'], status: 'decided' },
    beta: { owns: ['scripts/alpha/borrowed.ts', 'scripts/beta.ts'], contract: ['scripts/beta.ts'], may_use: [], status: 'undecided' },
  }),
  composition_roots: ['scripts/main.ts'],
  composition_imports: {},
  exclusions: { tests: ['scripts/tests/**'], fixtures: [], templates: [], generated: [], tooling: [] },
}
const SMALL_TREE = ['scripts/alpha/borrowed.ts', 'scripts/alpha/inner.ts', 'scripts/alpha/index.ts', 'scripts/beta.ts', 'scripts/main.ts', 'scripts/tests/alpha.test.ts']

function linesOf(spec: ModuleGraphSpec, files: readonly string[]): string[] {
  return ownershipFaults(spec, files).map(faultLine)
}

describe('module graph ownership (law 2)', () => {
  it('every source file on the tree belongs to exactly one module or one exclusion', () => {
    const files = sourceFiles(REPO_ROOT)

    expect(files.length).toBeGreaterThan(0)
    expect(linesOf(MODULE_GRAPH, files)).toEqual([])
  })

  it('a source file in no module and no exclusion is red', () => {
    const files = [...sourceFiles(REPO_ROOT), PLANTED]

    expect(linesOf(MODULE_GRAPH, files)).toEqual([`${PLANTED}: in no module and no exclusion`])
  })

  it('a small spec with every file held once has no fault', () => {
    expect(linesOf(SMALL, SMALL_TREE)).toEqual([])
    expect(ownerOf(SMALL, 'scripts/alpha/borrowed.ts')).toEqual(['beta'])
    expect(ownerOf(SMALL, 'scripts/alpha/inner.ts')).toEqual(['alpha'])
  })

  it('a file named by one module is carved out of the folder another module owns', () => {
    expect(SMALL.modules.alpha!.owns).toContain(`${CARVED_OUT}scripts/alpha/borrowed.ts`)
    expect(heldBy(SMALL.modules.alpha!.owns, 'scripts/alpha/borrowed.ts')).toBe(false)
  })

  it('a file two holders claim is red with both named', () => {
    const twice: ModuleGraphSpec = { ...SMALL, exclusions: { ...SMALL.exclusions, tooling: ['scripts/beta.ts'] } }

    expect(linesOf(twice, SMALL_TREE)).toEqual(['scripts/beta.ts: held by beta, exclusion:tooling'])
  })

  it('a contract outside the owns, a glob matching nothing and an unknown may_use are red', () => {
    const broken: ModuleGraphSpec = {
      ...SMALL,
      modules: {
        ...SMALL.modules,
        alpha: { ...SMALL.modules.alpha!, contract: ['scripts/beta.ts'], may_use: ['gamma', 'alpha'] },
        beta: { ...SMALL.modules.beta!, owns: [...SMALL.modules.beta!.owns, 'scripts/gone.ts'] },
      },
    }

    expect(linesOf(broken, SMALL_TREE)).toEqual([
      'beta: scripts/gone.ts matches no file',
      'alpha: contract scripts/beta.ts is not inside its owns',
      'alpha: may_use names gamma, which is not another module',
      'alpha: may_use names alpha, which is not another module',
    ])
  })

  it('composition_imports keyed by a file that is no composition root, or listing a missing importer, is red', () => {
    const listed: ModuleGraphSpec = { ...SMALL, composition_imports: { 'scripts/main.ts': ['scripts/alpha/inner.ts', 'scripts/alpha/gone.ts'], 'scripts/beta.ts': [] } }

    expect(linesOf(listed, SMALL_TREE)).toEqual([
      'composition_imports: scripts/main.ts lists scripts/alpha/gone.ts, which matches no file',
      'composition_imports: scripts/beta.ts is not a composition root',
    ])
  })

  it('a contract glob that matches no file is a fault', () => {
    const vanished: ModuleGraphSpec = {
      ...SMALL,
      modules: { ...SMALL.modules, alpha: { ...SMALL.modules.alpha!, contract: ['scripts/alpha/gone.ts'] } },
    }

    expect(linesOf(vanished, SMALL_TREE)).toEqual(['alpha: contract scripts/alpha/gone.ts is not inside its owns'])
  })

  it('an undecided module carries no contract, and its may_use names only decided modules', () => {
    const isDecided = (id: string): boolean => MODULE_GRAPH.modules[id]?.status === 'decided'
    const undecided = Object.entries(MODULE_GRAPH.modules).filter(([, spec]) => spec.status === 'undecided' && (spec.contract.length > 0 || !spec.may_use.every(isDecided)))

    expect(undecided.map(([id]) => id)).toEqual([])
  })

  it('every concept owner of the registry lies in exactly one module, which the section names it under', () => {
    const section = modulesSection()
    const holders = CONCEPTS.map(concept => [concept.id, Object.entries(section.modules).filter(([, spec]) => spec.concepts.includes(concept.id)).map(([id]) => id)] as const)

    expect(holders.filter(([, modules]) => modules.length !== 1)).toEqual([])
  })
})
