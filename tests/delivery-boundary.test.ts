import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { build } from 'tsup'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE } from '../scripts/bus/db.js'
import { productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const BUS_SOURCE = 'scripts/bus/'
const BUS_STORE_MODULE = 'node:sqlite'
const BUS_STORE_READER = 'src/commands/cost/bus.ts'
const SPAWN_MODULE = 'node:child_process'
const SPAWN_CARRIERS = ['src/commands/intake/bash-syntax.ts', 'src/detect/git.ts', 'src/detect/package-manager.ts']
const STATIC_IMPORT = 'import-statement'
const BUS_STORE_OPEN = /DatabaseSync\(([^)]*)\)/g
const READ_ONLY_OPEN = /readOnly:\s*true/
const BUILTIN_REACH = /getBuiltinModule\(/
const BUS_WRITE_STATEMENT = /\b(?:INSERT\s+INTO|CREATE\s+(?:TABLE|INDEX|TRIGGER|VIEW)|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|UPDATE\s+\w+\s+SET)\b/
const EXPERIMENTAL_WARNING = 'ExperimentalWarning'
const BUILD_TIMEOUT_MS = 120_000

interface BundleImport { path: string, kind: string, external?: boolean }
type BundleInputs = Record<string, { imports: BundleImport[] }>

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'delivery-boundary-'))
  roots.push(root)
  return root
}

function scratchBesideDependencies(): string {
  const cache = path.join(REPOSITORY, 'node_modules', '.cache')
  mkdirSync(cache, { recursive: true })
  const outDir = mkdtempSync(path.join(cache, 'delivery-boundary-'))
  roots.push(outDir)
  return outDir
}

interface ProductBundle { cli: string, inputs: BundleInputs }

async function buildProduct(outDir: string): Promise<ProductBundle> {
  await build({ ...productBuild, outDir, metafile: true, silent: true, config: false })
  const metafile = JSON.parse(readFileSync(path.join(outDir, 'metafile-esm.json'), 'utf8')) as { inputs: BundleInputs }
  return { cli: path.join(outDir, 'cli.js'), inputs: metafile.inputs }
}

function boundaryCrossings(inputs: BundleInputs): string[] {
  return Object.entries(inputs).flatMap(([input, { imports }]) => [
    ...(input.startsWith(BUS_SOURCE) ? [`${input}: bus code in the product`] : []),
    ...imports.filter(found => found.kind !== STATIC_IMPORT).map(found => `${input}: ${found.kind} of ${found.path}`),
    ...imports.filter(found => found.path === BUS_STORE_MODULE && input !== BUS_STORE_READER).map(() => `${input}: ${BUS_STORE_MODULE} outside ${BUS_STORE_READER}`),
    ...imports.filter(found => found.path === SPAWN_MODULE && !SPAWN_CARRIERS.includes(input)).map(() => `${input}: ${SPAWN_MODULE} outside the spawn carriers`),
  ])
}

describe('the product boundary of dist/cli.js', () => {
  it('names a dynamic import(), a require, child_process outside its carriers and node:sqlite outside its reader', () => {
    expect(boundaryCrossings({
      'src/a.ts': { imports: [{ path: './b.js', kind: 'dynamic-import' }, { path: 'node:fs', kind: 'require-call', external: true }] },
      'src/b.ts': { imports: [{ path: SPAWN_MODULE, kind: STATIC_IMPORT, external: true }, { path: BUS_STORE_MODULE, kind: STATIC_IMPORT, external: true }] },
      [BUS_STORE_READER]: { imports: [{ path: BUS_STORE_MODULE, kind: STATIC_IMPORT, external: true }] },
      [SPAWN_CARRIERS[0]]: { imports: [{ path: SPAWN_MODULE, kind: STATIC_IMPORT, external: true }] },
      'scripts/bus/db.ts': { imports: [] },
    })).toEqual([
      'src/a.ts: dynamic-import of ./b.js',
      'src/a.ts: require-call of node:fs',
      `src/b.ts: ${BUS_STORE_MODULE} outside ${BUS_STORE_READER}`,
      `src/b.ts: ${SPAWN_MODULE} outside the spawn carriers`,
      'scripts/bus/db.ts: bus code in the product',
    ])
  })

  it('the product build imports node:sqlite statically from its reader alone, opens it read-only, and the cli runs through its own shebang without the bus writer or an ExperimentalWarning', async () => {
    const root = scratch()
    const bundle = await buildProduct(scratchBesideDependencies())
    expect(Object.keys(bundle.inputs).some(input => input.startsWith('src/'))).toBe(true)
    expect(boundaryCrossings(bundle.inputs)).toEqual([])
    expect(bundle.inputs[BUS_STORE_READER]?.imports).toContainEqual(expect.objectContaining({ path: BUS_STORE_MODULE, kind: STATIC_IMPORT }))
    const cli = readFileSync(bundle.cli, 'utf8')
    expect(cli).not.toMatch(BUILTIN_REACH)
    const opens = [...cli.matchAll(BUS_STORE_OPEN)].map(([, options]) => options)
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatch(READ_ONLY_OPEN)
    expect(cli).not.toMatch(BUS_WRITE_STATEMENT)

    const repo = path.join(root, 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    writeFileSync(path.join(repo, 'src', 'a.ts'), '')
    const draft = path.join(root, 'draft.json')
    writeFileSync(draft, JSON.stringify({ cards: [{ name: 'boundary-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', touches: ['src/a.ts'], task: 'Cross the boundary.', witnesses: ['`pnpm run quality` is green'] }] }))
    const taken = path.join(root, 'taken.txt')
    writeFileSync(taken, '12\n')
    const parking = path.join(root, 'parking')
    const run = spawnSync(bundle.cli, ['intake', '--draft', draft, '--taken', taken, '--parking', parking, '--dir', repo, '--plain'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', [BUS_DB_VARIABLE]: path.join(root, 'bus.db') } })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stderr).not.toContain(EXPERIMENTAL_WARNING)
    expect(existsSync(path.join(parking, '13.md'))).toBe(true)
    expect(existsSync(path.join(root, 'bus.db'))).toBe(false)
  }, BUILD_TIMEOUT_MS)
})
