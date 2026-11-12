import type { ModuleGraphSpec, ModuleSpec } from '../../scripts/contract/factory/modules.js'
import type { MoveSources, RatchetNumbers } from '../../scripts/contract/ratchet.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { carvedOut, MODULE_GRAPH } from '../../scripts/contract/factory/modules.js'
import { boundaryNumbers, boundaryReport } from '../../scripts/contract/module-graph/boundary.js'
import { checkRatchet, specInTree } from '../../scripts/contract/ratchet.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SPAWN_TIMEOUT = 60_000
const SPEC_FILE = 'spec.json'
const MOVED_ROW = 'boundary:app->adapters'
const PORTS_ROW = 'boundary:app->ports'
const GIT_IDENTITY = ['-c', 'user.name=fixture', '-c', 'user.email=fixture', '-c', 'commit.gpgsign=false']
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function specOf(movedToAdapters: readonly string[]): ModuleGraphSpec {
  const adapters: Record<string, ModuleSpec> = movedToAdapters.length === 0 ? {} : { adapters: { owns: movedToAdapters, contract: [], may_use: [], status: 'decided' } }
  return {
    modules: carvedOut({
      app: { owns: ['scripts/app/**'], contract: [], may_use: [], status: 'decided' },
      ports: { owns: ['scripts/ports/**'], contract: [], may_use: [], status: 'undecided' },
      ...adapters,
    }),
    composition_roots: [],
    composition_imports: {},
    exclusions: { tests: [], fixtures: [], templates: [], generated: [], tooling: [] },
  }
}

const BEFORE = specOf([])
const MOVED = specOf(['scripts/ports/x.ts', 'scripts/ports/y.ts'])

const PORTS = {
  'scripts/ports/x.ts': 'export const x = 1\nexport const w = 2\n',
  'scripts/ports/y.ts': 'export const y = 1\n',
  'scripts/ports/z.ts': 'export const z = 1\n',
}

const MAIN = {
  ...PORTS,
  'scripts/app/use.ts': 'import { x } from \'../ports/x.js\'\nexport const use = x\n',
  'scripts/app/other.ts': 'import { y } from \'../ports/y.js\'\nexport const other = y\n',
  'scripts/app/old.ts': 'import { z } from \'../ports/z.js\'\nexport const old = z\n',
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...GIT_IDENTITY, ...args], { stdio: 'ignore' })
}

function write(root: string, files: Record<string, string | null>, spec?: ModuleGraphSpec): void {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(path.join(root, file))
      continue
    }
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  if (spec !== undefined)
    writeFileSync(path.join(root, SPEC_FILE), JSON.stringify(spec))
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}

function cardBranchedFromMain(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ratchet-move-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  git(root, 'init', '-q', '-b', 'main')
  write(root, MAIN, BEFORE)
  writeFileSync(path.join(root, 'src', '.keep'), '')
  commit(root, 'main')
  git(root, 'checkout', '-q', '-b', 'card')
  return root
}

function readSpec(tree: string): ModuleGraphSpec {
  return JSON.parse(readFileSync(path.join(tree, SPEC_FILE), 'utf8')) as ModuleGraphSpec
}

function numbersOf(root: string): RatchetNumbers {
  return boundaryNumbers(boundaryReport(root, readSpec(root), {}).violations)
}

function breaksAfter(root: string, recorded: RatchetNumbers): string[] {
  const sources: MoveSources = { headSpec: readSpec(root), readSpec, mainRefs: ['main'] }
  return checkRatchet(root, recorded, numbersOf(root), sources)
}

function movedRowBreaks(breaks: readonly string[]): string[] {
  return breaks.filter(line => line.startsWith(MOVED_ROW))
}

describe('the boundary ratchet under an ownership move', () => {
  it('moving files between modules with no new import passes', () => {
    const root = cardBranchedFromMain()
    const recorded = numbersOf(root)
    write(root, {}, MOVED)

    expect(numbersOf(root)[MOVED_ROW]).toBe(2)
    expect(breaksAfter(root, recorded)).toEqual([expect.stringContaining(`${PORTS_ROW} went down from 3 to 1`)])
    expect(breaksAfter(root, { ...recorded, [PORTS_ROW]: 1 })).toEqual([])
  })

  it('a moved destination file and a moved symbol keep their base identity', () => {
    const root = cardBranchedFromMain()
    const recorded = { ...numbersOf(root), [PORTS_ROW]: 1 }
    mkdirSync(path.join(root, 'scripts', 'adapters'))
    git(root, 'mv', 'scripts/ports/x.ts', 'scripts/adapters/x.ts')
    write(root, {
      'scripts/ports/y.ts': null,
      'scripts/adapters/lift.ts': 'export const y = 1\n',
      'scripts/app/use.ts': 'import { x } from \'../adapters/x.js\'\nexport const use = x\n',
      'scripts/app/other.ts': 'import { y } from \'../adapters/lift.js\'\nexport const other = y\n',
    }, { ...MOVED, modules: carvedOut({ ...specOf([]).modules, adapters: { owns: ['scripts/adapters/**'], contract: [], may_use: [], status: 'decided' } }) })

    expect(numbersOf(root)[MOVED_ROW]).toBe(2)
    expect(breaksAfter(root, recorded)).toEqual([])
  })

  it('the same move plus one new import is red', () => {
    const root = cardBranchedFromMain()
    const recorded = numbersOf(root)
    write(root, {
      'scripts/app/old.ts': 'export const old = 1\n',
      'scripts/app/fresh.ts': 'import { x } from \'../ports/x.js\'\nexport const fresh = x\n',
    }, MOVED)

    expect(movedRowBreaks(breaksAfter(root, recorded))).toEqual([expect.stringContaining(`${MOVED_ROW} grew from 0 to 3`)])
  })

  it('swapping one import for another at the same count is red', () => {
    const root = cardBranchedFromMain()
    const recorded = numbersOf(root)
    write(root, { 'scripts/app/other.ts': 'import { w } from \'../ports/x.js\'\nexport const other = w\n' }, MOVED)

    expect(numbersOf(root)[MOVED_ROW]).toBe(2)
    expect(movedRowBreaks(breaksAfter(root, recorded))).toEqual([expect.stringContaining(`${MOVED_ROW} grew from 0 to 2`)])
  })

  it('a move that raises total violations is red', () => {
    const root = cardBranchedFromMain()
    const recorded = numbersOf(root)
    write(root, { 'scripts/app/extra.ts': 'import { z } from \'../ports/z.js\'\nexport const extra = z\n' }, MOVED)

    expect(numbersOf(root)[PORTS_ROW]).toBe(2)
    expect(movedRowBreaks(breaksAfter(root, recorded))).toEqual([expect.stringContaining(`${MOVED_ROW} grew from 0 to 2`)])
  })

  it('the base is read from the commit the card branched from', () => {
    const root = cardBranchedFromMain()
    write(root, {
      'scripts/app/old.ts': 'export const old = 1\n',
      'scripts/app/early.ts': 'import { y } from \'../ports/y.js\'\nexport const early = y\n',
    })
    commit(root, 'a violation added on the card branch before the move')
    const recorded = numbersOf(root)
    write(root, {}, MOVED)

    expect(numbersOf(root)[MOVED_ROW]).toBe(3)
    expect(movedRowBreaks(breaksAfter(root, recorded))).toEqual([expect.stringContaining(`${MOVED_ROW} grew from 0 to 3`)])
  })

  it('the base spec is read from the module graph the base tree itself declares', { timeout: SPAWN_TIMEOUT }, () => {
    expect(specInTree(REPO_ROOT)).toEqual(JSON.parse(JSON.stringify(MODULE_GRAPH)))
  })
})
