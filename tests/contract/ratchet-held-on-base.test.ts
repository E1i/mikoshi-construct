import type { ModuleGraphSpec } from '../../scripts/contract/factory/modules.js'
import type { MoveSources, RatchetNumbers } from '../../scripts/contract/ratchet.js'
import type { GitRunner } from '../../scripts/ports/git.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { carvedOut } from '../../scripts/contract/factory/modules.js'
import { BOUNDARY_PREFIX, boundaryNumbers, boundaryReport } from '../../scripts/contract/module-graph/boundary.js'
import { checkRatchet, ownershipMoves, readRatchet, specInTree } from '../../scripts/contract/ratchet.js'
import { processGit } from '../../scripts/ports/git.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const REAL_CASE_TIMEOUT = 300_000
const SPEC_FILE = 'spec.json'
const MOVED_ROW = 'boundary:ports->adapters'
const APP_ROW = 'boundary:app->ports'
const GIT_IDENTITY = ['-c', 'user.name=fixture', '-c', 'user.email=fixture', '-c', 'commit.gpgsign=false']
const HEAD_OF_PR_1578 = '3fca761f'
const BRANCHED_FROM = '21cb92a6'
const PORTS_ADAPTERS_ROW = 'boundary:ports->ports-adapters'
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function specOf(adapterFiles: readonly string[]): ModuleGraphSpec {
  return {
    modules: carvedOut({
      app: { owns: ['scripts/app/**'], contract: [], may_use: ['adapters'], status: 'decided' },
      ports: { owns: ['scripts/ports/**'], contract: [], may_use: [], status: 'undecided' },
      adapters: { owns: adapterFiles, contract: adapterFiles, may_use: [], status: 'decided' },
    }),
    composition_roots: [],
    composition_imports: {},
    exclusions: { tests: [], fixtures: [], templates: [], generated: [], tooling: [] },
  }
}

const BEFORE = specOf([])
const MOVED = specOf(['scripts/ports/git.ts'])

const BASE = {
  'scripts/ports/git.ts': 'export const git = 1\nexport const fetch = 2\n',
  'scripts/ports/z.ts': 'export const z = 1\n',
  'scripts/ports/use.ts': 'import { git } from \'./git.js\'\nexport const use = git\n',
  'scripts/app/run.ts': 'import { git } from \'../ports/git.js\'\nexport const run = git\n',
  'scripts/app/old.ts': 'import { z } from \'../ports/z.js\'\nexport const old = z\n',
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...GIT_IDENTITY, ...args], { stdio: 'ignore' })
}

function write(root: string, files: Record<string, string>, spec?: ModuleGraphSpec): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  if (spec !== undefined)
    writeFileSync(path.join(root, SPEC_FILE), JSON.stringify(spec))
}

function cardBranchedFromMain(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ratchet-held-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  write(root, { ...BASE, 'src/.keep': '' }, BEFORE)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'main')
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

function grewLines(breaks: readonly string[]): string[] {
  return breaks.filter(line => line.includes(' grew from '))
}

function hasCommit(commit: string): boolean {
  return processGit.succeeds(REPO_ROOT, ['cat-file', '-e', `${commit}^{commit}`])
}

function treeOf(commit: string): string {
  const tree = mkdtempSync(path.join(tmpdir(), 'ratchet-real-'))
  roots.push(tree)
  execFileSync('tar', ['-x', '-C', tree], { input: processGit.readBytes(REPO_ROOT, ['archive', '--format=tar', commit], 1 << 30) })
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tree, 'node_modules'))
  return tree
}

function gitAsIfCheckedOutAt(head: string, base: string): GitRunner {
  return {
    ...processGit,
    readOrNull: (_tree, args, options) => args[0] === 'merge-base' ? base : processGit.readOrNull(REPO_ROOT, args[0] === 'diff' ? [...args, head] : args, options),
    readBytes: (_tree, args, maxBuffer, options) => processGit.readBytes(REPO_ROOT, args, maxBuffer, options),
  }
}

function boundaryRowsOf(numbers: RatchetNumbers): RatchetNumbers {
  return Object.fromEntries(Object.entries(numbers).filter(([key]) => key.startsWith(BOUNDARY_PREFIX)))
}

describe('the boundary ratchet holds every import the base already had', () => {
  it('an import inside one module that became a cross-module violation by an ownership change is held', () => {
    const root = cardBranchedFromMain()
    const recorded = numbersOf(root)
    write(root, {}, MOVED)

    expect(recorded[MOVED_ROW]).toBeUndefined()
    expect(numbersOf(root)[MOVED_ROW]).toBe(1)
    expect(breaksAfter(root, { ...recorded, [APP_ROW]: 1 })).toEqual([])
  })

  it('a new import in the same grown row is refused', () => {
    const root = cardBranchedFromMain()
    const recorded = { ...numbersOf(root), [APP_ROW]: 0 }
    write(root, {
      'scripts/app/old.ts': 'export const old = 1\n',
      'scripts/ports/fresh.ts': 'import { fetch } from \'./git.js\'\nexport const fresh = fetch\n',
    }, MOVED)

    expect(numbersOf(root)[MOVED_ROW]).toBe(2)
    expect(grewLines(breaksAfter(root, recorded))).toEqual([expect.stringContaining(`${MOVED_ROW} grew from 0 to 2`)])
  })

  it('a grown total of violating imports is refused', () => {
    const root = cardBranchedFromMain()
    const recorded = numbersOf(root)
    write(root, { 'scripts/app/extra.ts': 'import { z } from \'../ports/z.js\'\nexport const extra = z\n' }, MOVED)

    expect(numbersOf(root)[APP_ROW]).toBe(2)
    expect(grewLines(breaksAfter(root, recorded))).toEqual([expect.stringContaining(`${MOVED_ROW} grew from 0 to 1`)])
  })

  it.runIf(hasCommit(HEAD_OF_PR_1578) && hasCommit(BRANCHED_FROM))('the check on the head of PR 1578 at 3fca761f passes and reads the grown ports to ports-adapters row as a move', { timeout: REAL_CASE_TIMEOUT }, () => {
    const head = treeOf(HEAD_OF_PR_1578)
    const headSpec = specInTree(head)
    const recorded = boundaryRowsOf(readRatchet(head))
    const generated = boundaryNumbers(boundaryReport(head, headSpec).violations)
    const sources: MoveSources = { headSpec, readSpec: specInTree, git: gitAsIfCheckedOutAt(HEAD_OF_PR_1578, BRANCHED_FROM), env: {} }

    expect(recorded[PORTS_ADAPTERS_ROW] ?? 0).toBe(0)
    expect(generated[PORTS_ADAPTERS_ROW]).toBe(12)
    expect(ownershipMoves(head, [PORTS_ADAPTERS_ROW], sources)).toEqual(new Set([PORTS_ADAPTERS_ROW]))
    expect(grewLines(checkRatchet(head, recorded, generated, sources))).toEqual([])
  })
})
