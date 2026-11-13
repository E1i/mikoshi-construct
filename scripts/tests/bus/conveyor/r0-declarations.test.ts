import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MODULE_FILES, moduleFilesOf, ownershipOf, readDeclarations, renderModuleFiles, SLICED_CHECKS, trackedFrom, validateDeclarations } from '../../../core/declarations.js'
import { GENERATED_FILES, namedRowProblems, readGeneratedRows, rowsFolderAbove } from '../../../core/generated-files.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const RESTART_AREA = 'bus-restart'
const RESTART_CHECK = 'P-restart'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function repositoryFiles(): string[] {
  const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  return trackedFrom(listing, file => existsSync(path.join(REPO_ROOT, file)))
}

type Entry = Record<string, unknown>

interface Fixture {
  modules?: Record<string, Entry>
  contention?: Record<string, Entry>
  generated?: Record<string, Entry>
}

function fixture(kinds: Fixture): string {
  const root = mkdtempSync(path.join(tmpdir(), 'r0-declarations-'))
  roots.push(root)
  for (const [kind, entries] of Object.entries(kinds)) {
    mkdirSync(path.join(root, 'declarations', kind), { recursive: true })
    for (const [key, entry] of Object.entries(entries as Record<string, Entry>))
      writeFileSync(path.join(root, 'declarations', kind, `${key}.json`), JSON.stringify(entry))
  }
  return root
}

function module(name: string, paths: string[], more: Partial<Entry> = {}): Entry {
  return { module: name, layer: 'core', paths, exclude: [], shared: [], ...more }
}

function problemsOf(kinds: Fixture, tracked: string[]): string[] {
  return validateDeclarations(readDeclarations(fixture(kinds)), tracked)
}

describe('scenario 15, the validator part: the declaration folder of this repository', () => {
  it('declares the bus-restart contention area until P-restart, a check with a slice', () => {
    const { contention } = readDeclarations(REPO_ROOT)
    const area = contention.find(entry => entry.id === RESTART_AREA)
    expect(area).toMatchObject({ until: RESTART_CHECK })
    expect(area!.paths.length).toBeGreaterThan(0)
    expect(SLICED_CHECKS).toContain(RESTART_CHECK)
  })

  it('resolves every tracked file to exactly one owner, with no unused pattern, exclude or shared path', () => {
    expect(validateDeclarations(readDeclarations(REPO_ROOT), repositoryFiles())).toEqual([])
  })

  it('keeps contract/module-files.json equal to a fresh rebuild from the module paths and the tracked files', () => {
    const { modules } = readDeclarations(REPO_ROOT)
    expect(readFileSync(path.join(REPO_ROOT, MODULE_FILES), 'utf8')).toBe(renderModuleFiles(moduleFilesOf(modules, repositoryFiles())))
  })

  it('holds the GENERATED_FILES rows in declarations/generated, one file per row, module-files among them', () => {
    const rows = readGeneratedRows(path.join(REPO_ROOT, 'declarations', 'generated'))
    expect(Object.values(GENERATED_FILES)).toEqual(rows)
    expect(rows.map(row => row.path)).toContain(MODULE_FILES)
    expect(readFileSync(path.join(REPO_ROOT, 'scripts/core/generated-files.ts'), 'utf8')).not.toContain(GENERATED_FILES.factory.path)
    expect(namedRowProblems(rows)).toEqual([])
  })

  it('refuses a row folder that lacks a row the code names, or nulls a field the code reads', () => {
    const rows = readGeneratedRows(path.join(REPO_ROOT, 'declarations', 'generated'))
    const withoutFactory = rows.filter(row => row.id !== 'factory')
    const nullRebuild = rows.map(row => row.id === 'surface' ? { ...row, rebuild: null } : row)
    expect(namedRowProblems(withoutFactory)).toEqual(['declarations/generated/ has no row factory, which the code names'])
    expect(namedRowProblems(nullRebuild)).toEqual(['declarations/generated/surface.json: rebuild is null, and the code reads it'])
    const unpacked = rows.map(row => row.id === 'model' ? { ...row, rebuild: ['exec', 'tsx', 'scripts/model/render.ts'] } : row)
    expect(namedRowProblems(unpacked)).toEqual(['declarations/generated/model.json: runs scripts/model/render.ts, which SCRIPTS_THE_ROWS_RUN does not name, so the factory build does not pack it'])
  })

  it('finds the rows from a bundle anywhere below the package root', () => {
    expect(rowsFolderAbove(path.join(REPO_ROOT, 'node_modules', '.cache', 'bundle'))).toBe(path.join(REPO_ROOT, 'declarations', 'generated'))
  })
})

describe('scenario 15, the validator part: what the validator refuses', () => {
  it('refuses an area whose until names a check with no slice', () => {
    const problems = problemsOf({
      modules: { a: module('a', ['scripts/']) },
      contention: { 'bus-restart': { id: 'bus-restart', paths: ['scripts/'], why: 'restarts the bus', until: 'restart-someday' } },
    }, ['scripts/a.ts'])
    expect(problems).toEqual(['declarations/contention/bus-restart.json: until names "restart-someday", a check with no slice'])
  })

  it('accepts the same area until P-restart', () => {
    expect(problemsOf({
      modules: { a: module('a', ['scripts/']) },
      contention: { 'bus-restart': { id: 'bus-restart', paths: ['scripts/'], why: 'restarts the bus', until: RESTART_CHECK } },
    }, ['scripts/a.ts'])).toEqual([])
  })

  it('refuses a key that differs from its file name, in every kind', () => {
    const problems = problemsOf({
      modules: { a: module('b', ['scripts/']) },
      contention: { area: { id: 'other', paths: ['scripts/'], why: 'w', until: RESTART_CHECK } },
      generated: { row: { id: 'rows', module: 'a', path: 'scripts/a.ts', rebuild: null, check: null, rebuiltOnUpdate: false, seamSources: null, followSources: null } },
    }, ['scripts/a.ts'])
    expect(problems).toEqual(expect.arrayContaining([
      'declarations/modules/a.json: its key "b" differs from its file name "a"',
      'declarations/contention/area.json: its key "other" differs from its file name "area"',
      'declarations/generated/row.json: its key "rows" differs from its file name "row"',
    ]))
  })

  it('reports two entries of equal specificity matching one file as an error, never a tie broken by module order', () => {
    const modules = { a: module('a', ['scripts/core/*.ts']), b: module('b', ['scripts/core/']) }
    expect(problemsOf({ modules }, ['scripts/core/x.ts'])).toEqual(['scripts/core/x.ts: a, b match it with equal specificity'])
    expect(problemsOf({ modules: { b: modules.b, a: modules.a } }, ['scripts/core/x.ts'])).toEqual(['scripts/core/x.ts: a, b match it with equal specificity'])
    expect(problemsOf({ modules: { a: module('a', ['x.ts']), b: module('b', ['x.ts']) } }, ['x.ts'])).toEqual(['x.ts: a, b match it with equal specificity'])
  })

  it('reports a tracked file no module owns', () => {
    expect(problemsOf({ modules: { a: module('a', ['scripts/']) } }, ['scripts/a.ts', 'README.md'])).toEqual(['README.md: no module owns it'])
  })

  it('reports a pattern that matches nothing, an exclude that removes nothing, and a shared path claimed twice', () => {
    const problems = problemsOf({
      modules: {
        a: module('a', ['scripts/', 'gone/'], { exclude: ['docs/'], shared: ['package.json'] }),
        b: module('b', ['docs/'], { shared: ['package.json'] }),
      },
    }, ['scripts/a.ts', 'docs/b.md', 'package.json'])
    expect(problems).toEqual(expect.arrayContaining([
      'declarations/modules/a.json: paths entry "gone/" matches no tracked file',
      'declarations/modules/a.json: exclude entry "docs/" removes no file its own paths match',
      'shared path "package.json" is claimed by a, b; one module owns it',
    ]))
  })

  it('refuses a generated row whose file its module does not own', () => {
    const problems = problemsOf({
      modules: { a: module('a', ['scripts/']), b: module('b', ['contract/']) },
      generated: { record: { id: 'record', module: 'a', path: 'contract/record.json', rebuild: ['record:update'], check: null, rebuiltOnUpdate: false, seamSources: null, followSources: null } },
    }, ['scripts/a.ts', 'contract/record.json'])
    expect(problems).toEqual(['declarations/generated/record.json: contract/record.json is not owned by the generator\'s module a'])
  })

  it('reports a shared path that a module other than its owner names in paths or exclude', () => {
    const problems = problemsOf({
      modules: {
        a: module('a', ['scripts/'], { shared: ['package.json'] }),
        b: module('b', ['docs/', 'package.json']),
      },
    }, ['scripts/a.ts', 'docs/b.md', 'package.json'])
    expect(problems).toContain('shared path "package.json" of a is named by b as well')
  })

  it('refuses a contention area whose module is not declared', () => {
    expect(problemsOf({
      modules: { a: module('a', ['scripts/']) },
      contention: { area: { id: 'area', module: 'ghost', paths: ['scripts/'], why: 'w', until: RESTART_CHECK } },
    }, ['scripts/a.ts'])).toEqual(['declarations/contention/area.json: module "ghost" is not declared'])
  })

  it('refuses a generated row whose module is not declared', () => {
    expect(problemsOf({
      modules: { a: module('a', ['scripts/']) },
      generated: { record: { id: 'record', module: 'ghost', path: 'scripts/a.ts', rebuild: null, check: null, rebuiltOnUpdate: false, seamSources: null, followSources: null } },
    }, ['scripts/a.ts'])).toEqual(['declarations/generated/record.json: module "ghost" is not declared'])
  })

  it('refuses a folder under declarations/ that is not a kind the validator reads', () => {
    expect(problemsOf({
      modules: { a: module('a', ['scripts/']) },
      unknown: { thing: { id: 'thing' } },
    } as Fixture, ['scripts/a.ts'])).toEqual(['declarations/unknown: not a declaration kind this validator reads (modules, contention, generated)'])
  })

  it('refuses a pattern in shared, which names one file', () => {
    expect(problemsOf({
      modules: { a: module('a', ['scripts/'], { shared: ['scripts/*.ts'] }) },
    }, ['scripts/a.ts'])).toContain('declarations/modules/a.json: shared names "scripts/*.ts", which is a pattern, not one file')
  })
})

describe('resolution by specificity', () => {
  const modules = [
    { module: 'folder', layer: 'l', paths: ['scripts/'], exclude: ['scripts/tests/'], shared: [] },
    { module: 'glob', layer: 'l', paths: ['scripts/core/*.ts'], exclude: [], shared: [] },
    { module: 'exact', layer: 'l', paths: ['scripts/core/odd.ts'], exclude: [], shared: [] },
    { module: 'deep', layer: 'l', paths: ['scripts/**/fixtures/**'], exclude: [], shared: [] },
    { module: 'shared', layer: 'l', paths: ['docs/'], exclude: [], shared: ['scripts/registry.json'] },
  ]

  it('an exact path beats any pattern, and a shared path is an exact one', () => {
    expect(ownershipOf(modules, 'scripts/core/odd.ts').owner).toBe('exact')
    expect(ownershipOf(modules, 'scripts/registry.json').owner).toBe('shared')
  })

  it('among patterns the longest literal prefix wins, a folder counting as its path with a trailing **', () => {
    expect(ownershipOf(modules, 'scripts/core/even.ts').owner).toBe('glob')
    expect(ownershipOf(modules, 'scripts/core/nested/even.ts').owner).toBe('folder')
    expect(ownershipOf(modules, 'scripts/core/data.json').owner).toBe('folder')
    expect(ownershipOf(modules, 'scripts/a/fixtures/b.ts')).toEqual({ owner: null, tied: ['deep', 'folder'] })
    expect(ownershipOf(modules, 'scripts/a/fixtures/nested/b.ts')).toEqual({ owner: null, tied: ['deep', 'folder'] })
  })

  it('an exclude removes a path from its own module and assigns it nowhere', () => {
    expect(ownershipOf(modules, 'scripts/tests/a.test.ts')).toEqual({ owner: null, tied: [] })
  })

  it('rebuilds the file list per module from the patterns, every module present', () => {
    expect(moduleFilesOf(modules, ['scripts/core/odd.ts', 'scripts/core/even.ts', 'docs/a.md'])).toEqual({
      deep: [],
      exact: ['scripts/core/odd.ts'],
      folder: [],
      glob: ['scripts/core/even.ts'],
      shared: ['docs/a.md'],
    })
  })
})
