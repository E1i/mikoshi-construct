import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import INTERNAL_MODULES from '../../../../internal-modules.json' with { type: 'json' }
import { ESLINT_EDGES, eslintEdgesOf, readDeclarations, renderEslintEdges, trackedFrom, validateDeclarations } from '../../../core/declarations.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const MAY_USE = path.join('declarations', 'may-use')
const CONFIG_FILES = ['eslint.config.mjs', 'internal-modules.json', 'scripts/quality/real-time-waits-excepted.json']
const REACHES_UI = 'import { createUi } from \'./ui/console.js\'\n\nexport const probe = createUi\n'
const DETECT_REACHES_UI = 'import { createUi } from \'../ui/console.js\'\n\nexport const probe = createUi\n'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function repositoryFiles(): string[] {
  const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  return trackedFrom(listing, file => existsSync(path.join(REPO_ROOT, file)))
}

function scratch(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'r-lint-')))
  roots.push(root)
  return root
}

function checkoutWithTheRepositoryConfig(): string {
  const root = scratch()
  for (const file of CONFIG_FILES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.join(REPO_ROOT, file), path.join(root, file))
  }
  cpSync(path.join(REPO_ROOT, MAY_USE), path.join(root, MAY_USE), { recursive: true })
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'))
  return root
}

function assemble(root: string): void {
  const declarations = readDeclarations(root)
  expect(declarations.problems).toEqual([])
  mkdirSync(path.join(root, 'contract'), { recursive: true })
  writeFileSync(path.join(root, ESLINT_EDGES), renderEslintEdges(eslintEdgesOf(declarations.mayUse, repositoryFiles())))
}

async function restrictedImports(root: string, file: string, source: string): Promise<string[]> {
  const [result] = await new ESLint({ cwd: root }).lintText(source, { filePath: path.join(root, file) })
  return result!.messages.map(message => message.ruleId ?? '').filter(rule => rule === 'no-restricted-imports')
}

function writeEdge(root: string, module: string, mayUse: string[]): void {
  writeFileSync(path.join(root, MAY_USE, `${module}.json`), JSON.stringify({ module, may_use: mayUse, may_use_factory: [], may_use_factory_within: {} }))
}

function problemsOf(edges: Record<string, Record<string, unknown>>, tracked: string[]): string[] {
  const root = scratch()
  mkdirSync(path.join(root, MAY_USE), { recursive: true })
  mkdirSync(path.join(root, 'declarations', 'modules'), { recursive: true })
  writeFileSync(path.join(root, 'declarations', 'modules', 'everything.json'), JSON.stringify({ module: 'everything', layer: 'core', paths: ['src/', 'scripts/'], exclude: [], shared: [] }))
  writeFileSync(path.join(root, 'internal-modules.json'), JSON.stringify(['detect', 'ui']))
  for (const [key, entry] of Object.entries(edges))
    writeFileSync(path.join(root, MAY_USE, `${key}.json`), JSON.stringify({ module: key, may_use: [], may_use_factory: [], may_use_factory_within: {}, ...entry }))
  return validateDeclarations(readDeclarations(root), tracked)
}

describe('r-lint: the eslint edge lists are assembled from declarations/may-use', () => {
  it('keeps contract/eslint-edges.json equal to a fresh assembly of the may-use folder', () => {
    const { mayUse } = readDeclarations(REPO_ROOT)
    expect(readFileSync(path.join(REPO_ROOT, ESLINT_EDGES), 'utf8')).toBe(renderEslintEdges(eslintEdgesOf(mayUse, repositoryFiles())))
  })

  it('names only modules of internal-modules.json, and gathers every core/ file a src module may import', () => {
    const edges = eslintEdgesOf(readDeclarations(REPO_ROOT).mayUse, repositoryFiles())
    const named = Object.keys(edges.allowedInternalImports).map(target => target.replace(/^src\//, '').replace(/\.ts$/, ''))
    expect(named.filter(name => !INTERNAL_MODULES.includes(name))).toEqual([])
    expect(Object.values(edges.allowedInternalImports).flat().filter(name => !INTERNAL_MODULES.includes(name))).toEqual([])
    expect(edges.coreFilesSrcMayImport).toEqual([...new Set(Object.values(edges.allowedFactoryImports).flat().filter(entry => entry.startsWith('core/')))].sort())
    expect(edges.coreFilesSrcMayImport).toContain('core/owner-commands.js')
  })

  it('gives every boundary eslint.config.mjs resolves the lists of the assembly', async () => {
    const edges = eslintEdgesOf(readDeclarations(REPO_ROOT).mayUse, repositoryFiles())
    const eslint = new ESLint({ cwd: REPO_ROOT })
    const messagesAt = async (target: string): Promise<string[]> => {
      const resolved = await eslint.calculateConfigForFile(path.join(REPO_ROOT, target.endsWith('.ts') ? target : `${target}/probe.ts`))
      const rule = resolved.rules['no-restricted-imports'] as [number, { patterns?: { message?: string }[] }]
      return (rule[1].patterns ?? []).map(pattern => pattern.message ?? '')
    }
    for (const [target, allowed] of Object.entries(edges.allowedInternalImports)) {
      const directory = target.replace(/\.ts$/, '')
      expect(await messagesAt(target), target).toContain(allowed.length === 0 ? `${directory} imports no other src module: it returns facts` : `${directory} may import only ${allowed.join(', ')}`)
    }
    for (const [target, allowed] of Object.entries(edges.allowedFactoryImports))
      expect(await messagesAt(target), target).toContain(`${target.replace(/\.ts$/, '')} may reach into scripts/ only through ${allowed.join(', ')}: the factory ships as its own build`)
  })

  it('assembles the same output whatever order the entries arrive in', () => {
    const { mayUse } = readDeclarations(REPO_ROOT)
    const tracked = repositoryFiles()
    expect(renderEslintEdges(eslintEdgesOf([...mayUse].reverse(), tracked))).toBe(renderEslintEdges(eslintEdgesOf(mayUse, tracked)))
  })

  it('changes the lint result when an edge file is added or widened, with eslint.config.mjs unedited', async () => {
    const before = checkoutWithTheRepositoryConfig()
    assemble(before)
    expect(await restrictedImports(before, 'src/version.ts', REACHES_UI)).toEqual([])
    expect(await restrictedImports(before, 'src/detect/probe.ts', DETECT_REACHES_UI)).toEqual(['no-restricted-imports'])

    const after = checkoutWithTheRepositoryConfig()
    writeEdge(after, 'version', [])
    writeEdge(after, 'detect', ['ui'])
    assemble(after)
    expect(readFileSync(path.join(after, 'eslint.config.mjs'), 'utf8')).toBe(readFileSync(path.join(REPO_ROOT, 'eslint.config.mjs'), 'utf8'))
    expect(await restrictedImports(after, 'src/version.ts', REACHES_UI)).toEqual(['no-restricted-imports'])
    expect(await restrictedImports(after, 'src/detect/probe.ts', DETECT_REACHES_UI)).toEqual([])
  })
})

describe('r-lint: what the validator refuses in a may-use entry', () => {
  const tracked = ['src/detect/index.ts', 'src/ui/console.ts', 'scripts/core/events.ts']

  it('accepts an entry whose names, factory imports and sub-folders all exist', () => {
    expect(problemsOf({ ui: { may_use: ['detect'], may_use_factory: ['core/events.js'] } }, tracked)).toEqual([])
  })

  it('refuses a module or a may_use name that internal-modules.json does not list, and an edge to itself', () => {
    expect(problemsOf({ ghost: {} }, tracked)).toEqual(['declarations/may-use/ghost.json: module "ghost" is not in internal-modules.json'])
    expect(problemsOf({ ui: { may_use: ['ghost', 'ui'] } }, tracked)).toEqual([
      'declarations/may-use/ui.json: may_use names "ghost", which is not in internal-modules.json',
      'declarations/may-use/ui.json: may_use names the module itself',
    ])
  })

  it('refuses a factory import with no file behind it and a sub-folder that holds nothing', () => {
    expect(problemsOf({ ui: { may_use_factory: ['core/gone.js', 'core/events.ts'], may_use_factory_within: { nowhere: [] } } }, tracked)).toEqual([
      'declarations/may-use/ui.json: factory import "core/gone.js" names no tracked file under scripts/',
      'declarations/may-use/ui.json: factory import "core/events.ts" is neither a .js module nor a folder ending in /',
      'declarations/may-use/ui.json: may_use_factory_within names "nowhere", and src/ui/nowhere/ holds no tracked file',
    ])
  })

  it('refuses a key that differs from its file name and a field of the wrong shape', () => {
    expect(problemsOf({ ui: { module: 'detect' } }, tracked)).toEqual(['declarations/may-use/ui.json: its key "detect" differs from its file name "ui"'])
    expect(problemsOf({ ui: { may_use: 'detect', may_use_factory_within: [] } }, tracked)).toEqual([
      'declarations/may-use/ui.json: may_use is not a list of non-empty strings',
      'declarations/may-use/ui.json: may_use_factory_within is not an object of lists of non-empty strings',
    ])
  })
})
