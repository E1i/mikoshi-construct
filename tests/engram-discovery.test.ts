import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { runInit } from '../src/commands/init.js'
import { readTrackedFiles } from '../src/detect/git.js'
import { discoverMechanics, ENGRAM_HOME_DIR, writeEngram } from '../src/model/discovery.js'
import { scanModule } from '../src/model/scan.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

const FOREIGN_SHOP: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'shop', private: true, scripts: { quality: 'node --version' } }, null, 2)}\n`,
  'src/orders/api.ts': [
    'import type { Order } from \'./order.js\'',
    'import { save } from \'./store.js\'',
    'import * as audit from \'../audit/log.js\'',
    '',
    'export function place(order: Order): void {',
    '  // save(order) is not a call',
    '  const label = \'save(order)\'',
    '  save(order)',
    '  audit.write(label)',
    '}',
    '',
  ].join('\n'),
  'src/orders/order.ts': 'export interface Order { id: string }\n',
  'src/orders/store.ts': [
    'import type { Order } from \'./order.js\'',
    'import { missing } from \'./gone.js\'',
    '',
    'export function save(order: Order): void {',
    '  missing(order.id)',
    '}',
    '',
  ].join('\n'),
  'src/audit/log.ts': 'export function write(line: string): string {\n  return line\n}\n',
  'src/index.ts': 'export { place } from \'./orders/api.js\'\n',
  'README.md': '# shop\n',
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function foreignRepository(files: Record<string, string> = FOREIGN_SHOP): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-discovery-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

describe('discovery writes what it found in the code into the Engram', () => {
  it('two runs on one fixture write a byte-identical engram', () => {
    const dir = foreignRepository()
    const first = readFileSync(writeEngram(dir, { attached: true, home: home() }))
    const second = readFileSync(writeEngram(dir, { attached: true, home: home() }))
    expect(second.equals(first)).toBe(true)
    expect(first.toString()).not.toContain(dir)
  })

  it('finds the components, their relations and the source line of each in a repository that is not Mikoshi', () => {
    const dir = foreignRepository()
    const mechanics = discoverMechanics(dir)
    expect(mechanics.identity).toEqual({ sha: git(dir, 'rev-parse', 'HEAD').trim(), status: 'found', source: { command: 'git rev-parse HEAD', exit: 0, effects: [] } })
    expect(mechanics.tree).toEqual({ status: 'found', source: { command: 'git ls-files -z', exit: 0, effects: [] } })
    expect(mechanics.components.map(component => component.path)).toEqual(['src/audit/log.ts', 'src/index.ts', 'src/orders/api.ts', 'src/orders/order.ts', 'src/orders/store.ts'])
    const found = mechanics.relations.filter(relation => relation.status === 'found').map(relation => `${relation.source.path}:${relation.source.line} ${relation.kind} ${relation.to}`)
    expect(found).toEqual([
      'src/index.ts:1 imports src/orders/api.ts',
      'src/orders/api.ts:1 imports src/orders/order.ts',
      'src/orders/api.ts:2 imports src/orders/store.ts',
      'src/orders/api.ts:3 imports src/audit/log.ts',
      'src/orders/api.ts:8 calls src/orders/store.ts',
      'src/orders/api.ts:9 calls src/audit/log.ts',
      'src/orders/store.ts:1 imports src/orders/order.ts',
    ])
  })

  it('marks a relation whose import resolves to no tracked file unknown instead of guessing its target', () => {
    const mechanics = discoverMechanics(foreignRepository())
    const unknown = mechanics.relations.filter(relation => relation.status === 'unknown')
    expect(unknown).toEqual([
      { from: 'src/orders/store.ts', to: null, kind: 'imports', specifier: './gone.js', status: 'unknown', source: { path: 'src/orders/store.ts', line: 2 } },
      { from: 'src/orders/store.ts', to: null, kind: 'calls', specifier: './gone.js', status: 'unknown', source: { path: 'src/orders/store.ts', line: 5 } },
    ])
  })

  it('marks the identity and the tree unknown in a directory git does not hold', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-discovery-plain-'))
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    const mechanics = discoverMechanics(dir)
    expect(mechanics.identity.sha).toBeNull()
    expect(mechanics.identity.status).toBe('unknown')
    expect(mechanics.identity.source.exit).not.toBe(0)
    expect(mechanics.tree.status).toBe('unknown')
    expect(mechanics.components).toEqual([])
  })

  it('turns no component into a capability and gives none a state', () => {
    const dir = foreignRepository()
    const model = parseModel(readFileSync(writeEngram(dir, { attached: true, home: home() }), 'utf8'), MODEL_FILE)
    expect([model.stages, model.nodes, model.links, model.facts, model.claims, model.hypotheses]).toEqual([[], [], [], [], [], []])
    expect(model.mechanics?.components.length).toBe(5)
    for (const component of model.mechanics?.components ?? [])
      expect(Object.keys(component)).toEqual(['id', 'path'])
  })

  it('writes the engram of an attached repository under the home directory and leaves the target tree untouched', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    expect(git(dir, 'status', '--porcelain')).toBe('')
    const file = writeEngram(dir, { attached: true, home: home() })
    expect(file).toBe(path.join(home(), ENGRAM_HOME_DIR, path.basename(dir), MODEL_FILE))
    expect(existsSync(path.join(dir, MODEL_FILE))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(parseModel(readFileSync(file, 'utf8'), MODEL_FILE).mechanics?.relations.length).toBeGreaterThan(0)
  })

  it('writes the engram of an init repository into its own construct.model.json and keeps its facts and claims', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-discovery-init-'))
    await runInit(ui, { dir, yes: true, dryRun: false, preset: 'node-backend', ai: 'claude' })
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'init')
    const before = parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE)
    const file = writeEngram(dir, { attached: false, home: home() })
    expect(file).toBe(path.join(dir, MODEL_FILE))
    const after = parseModel(readFileSync(file, 'utf8'), MODEL_FILE)
    expect([after.facts, after.claims]).toEqual([before.facts, before.claims])
    expect(after.mechanics?.components.some(component => component.path === 'src/app.ts')).toBe(true)
  })
})

describe('the module scan reads imports and calls from code, not from comments or strings', () => {
  it('ignores an import or a call that sits in a comment or a string', () => {
    const reading = scanModule([
      '// import { a } from \'./a.js\'',
      'const text = "import { b } from \'./b.js\'"',
      '/* c() */',
      'import { c } from \'./c.js\'',
      'c()',
      '',
    ].join('\n'))
    expect(reading.imports.map(entry => entry.specifier)).toEqual(['./c.js'])
    expect(reading.calls).toEqual([{ name: 'c', member: false, line: 5 }])
  })
})

describe('the module scan keeps each statement on its own line', () => {
  it('reads an import or a re-export at its own line when a local export precedes it', () => {
    const reexport = scanModule('export { A }\nexport { b } from \'./b.js\'\n')
    expect(reexport.imports).toEqual([{ specifier: './b.js', line: 2, bindings: [], namespaces: [] }])
    const imported = scanModule('export function a() {}\nimport { c } from \'./c.js\'\nc()\n')
    expect(imported.imports).toEqual([{ specifier: './c.js', line: 2, bindings: ['c'], namespaces: [] }])
    expect(imported.calls).toEqual([{ name: 'c', member: false, line: 3 }])
  })
})

describe('discovery reads only what git holds and only inside the repository', () => {
  it('reads the whole tracked list when it is longer than a mebibyte', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-discovery-large-'))
    git(dir, 'init', '-q')
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, encoding: 'utf8', input: '' }).trim()
    const paths = Array.from({ length: 12000 }, (_, index) => `${'d'.repeat(90)}/file-${String(index).padStart(6, '0')}.txt`)
    execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: dir, input: paths.map(entry => `100644 ${blob} 0\t${entry}\n`).join('') })
    const reading = readTrackedFiles(dir)
    expect(reading.stdout.length).toBeGreaterThan(1024 * 1024)
    expect(reading.exit).toBe(0)
    expect(reading.stdout.split('\0').filter(entry => entry !== '')).toEqual(paths)
  })

  it('reads no file through a tracked symlink', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'construct-discovery-outside-'))
    writeFileSync(path.join(outside, 'target.ts'), 'import { leak } from \'./outside-marker.js\'\nleak()\n')
    const dir = foreignRepository({ 'a.ts': 'export const a = 1\n' })
    symlinkSync(path.join(outside, 'target.ts'), path.join(dir, 'link.ts'))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'link')
    const mechanics = discoverMechanics(dir)
    expect(mechanics.components.map(component => component.path)).toEqual(['a.ts', 'link.ts'])
    expect(mechanics.relations.some(relation => relation.from === 'link.ts')).toBe(false)
    expect(readFileSync(writeEngram(dir, { attached: true, home: home() }), 'utf8')).not.toContain('outside-marker')
  })
  it('reads no file through a directory that became a symlink after the commit', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'construct-discovery-outside-dir-'))
    writeFileSync(path.join(outside, 'a.ts'), 'import { leak } from \'./outside-marker.js\'\nleak()\n')
    const dir = foreignRepository({ 'src/a.ts': 'export const a = 1\n' })
    rmSync(path.join(dir, 'src'), { recursive: true, force: true })
    symlinkSync(outside, path.join(dir, 'src'))
    const mechanics = discoverMechanics(dir)
    expect(mechanics.relations.some(relation => relation.from === 'src/a.ts')).toBe(false)
    expect(readFileSync(writeEngram(dir, { attached: true, home: home() }), 'utf8')).not.toContain('outside-marker')
  })
})

describe('the model refuses a mechanics block that contradicts itself', () => {
  const command = { command: 'git rev-parse HEAD', exit: 0, effects: [] }
  const found = {
    identity: { sha: 'a'.repeat(40), status: 'found', source: command },
    tree: { status: 'found', source: command },
    components: [{ id: 'a.ts', path: 'a.ts' }, { id: 'b.ts', path: 'b.ts' }],
    relations: [{ from: 'a.ts', to: 'b.ts', kind: 'imports', specifier: './b.js', status: 'found', source: { path: 'a.ts', line: 1 } }],
  }
  const document = (mechanics: unknown): string => JSON.stringify({ modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [], stages: [], nodes: [], links: [], mechanics })
  const refused: Array<[string, unknown]> = [
    ['a component with a state', { ...found, components: [{ id: 'a.ts', path: 'a.ts', state: 'verified' }] }],
    ['a component with a stage', { ...found, components: [{ id: 'a.ts', path: 'a.ts', stage: 'build' }] }],
    ['an unknown relation with a target', { ...found, relations: [{ ...found.relations[0], status: 'unknown' }] }],
    ['a found relation naming no component', { ...found, relations: [{ ...found.relations[0], to: 'c.ts' }] }],
    ['a duplicate component id', { ...found, components: [{ id: 'a.ts', path: 'a.ts' }, { id: 'a.ts', path: 'a.ts' }] }],
    ['a found identity with no sha', { ...found, identity: { ...found.identity, sha: null } }],
    ['an unknown identity with a sha', { ...found, identity: { ...found.identity, status: 'unknown' } }],
    ['an unknown tree with components', { ...found, tree: { ...found.tree, status: 'unknown' } }],
  ]

  it('accepts the block that is consistent', () => {
    expect(parseModel(document(found), MODEL_FILE).mechanics?.components.length).toBe(2)
  })

  it('refuses a mechanics block whose component carries a state or whose status contradicts its evidence', () => {
    for (const [, mechanics] of refused)
      expect(() => parseModel(document(mechanics), MODEL_FILE)).toThrow()
  })
})
