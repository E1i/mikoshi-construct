import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USAGE as MIKO_WATCH_USAGE } from '../scripts/miko/watch.js'
import { ownerChannelOf, UNUSED_WORD } from '../scripts/owner/channel.js'
import { USAGE as OWNER_SAY_USAGE, PREFIX } from '../scripts/owner/say.js'
import { USAGE as SHARD_USAGE } from '../scripts/shift/shard.js'
import { assetsNamedBy, copyFactoryAssets, FACTORY_DIRECTORIES, factoryAssets, factoryBuild, factoryEntries, factoryGraph, importsOf, locatedBy, OUT_DIR, productBuild, scriptsNamedBy } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const TEMPLATES = 'templates/'
const PACKED_BESIDE_THE_BUILD = ['package.json', 'README.md', 'LICENSE', 'templates']
const OWNER_SAY_ENTRY = 'scripts/owner/say.ts'
const SAID = 'the factory starts from the package'
const SAID_THROUGH_THE_CLI = 'construct say reaches the owner channel'
const TSX = 'tsx'
const PACK_TIMEOUT_MS = 300_000
const METAFILE = 'metafile-esm.json'
const SOURCE_ROOTS = /^(?:scripts|src)\//
const TEST_SOURCES = 'scripts/tests/'
const SCRIPT_PATH_IN_BUILT_CODE = /(?<![\w./-])((?:scripts|src)\/[\w./-]+\.ts)\b/g
const BUNDLER_SOURCE_COMMENT = /^\s*\/\/ .*$/gm

const STARTS: Record<string, { args: string[], exit: number, prints: string }> = {
  'scripts/bus/reducer.ts': { args: [], exit: 0, prints: 'applied 0, rejected 0' },
  'scripts/decisions/read.ts': { args: [], exit: 1, prints: '[decisions] no decisions at' },
  'scripts/ghosts/role.ts': { args: ['review', '--task', 't1'], exit: 0, prints: 'local: launch the review agent for t1' },
  'scripts/miko/watch.ts': { args: ['--bogus'], exit: 2, prints: MIKO_WATCH_USAGE },
  'scripts/owner/say.ts': { args: [], exit: 2, prints: OWNER_SAY_USAGE },
  'scripts/shift/shard.ts': { args: [], exit: 1, prints: SHARD_USAGE },
}

const SPAWNED_BY_THE_FACTORY: Record<string, string> = {
  'scripts/shift/brief-finish-cli.ts': 'scripts/bus/ladder-starter.ts',
  'scripts/shift/tree-pr-cli.ts': 'scripts/bus/launch-starter.ts',
  'scripts/attach/earlier-carriers.ts': 'scripts/bus/witnesses.ts',
  'scripts/ci/prepush.ts': 'scripts/bus/answerer.ts',
  'scripts/ci/sandbox-trace.ts': 'scripts/ci/sandbox-liveness.ts',
}

const READ_BESIDE_THE_MODULE: Record<string, string> = {
  'scripts/shift/header.md': 'scripts/bus/launch-worker.ts',
  'scripts/construct/check-acceptance.mjs': 'scripts/ghosts/hash.ts',
  '.claude/hooks/eddies-measure.mjs': 'scripts/miko/eddies-measure.ts',
  'scripts/ci/sandbox-trace-child.mjs': 'scripts/ci/sandbox-trace.ts',
  'scripts/ci/sandbox-failing.jsonl': 'scripts/ci/sandbox-failing.ts',
  'contract/contours': 'scripts/contract/contours.ts',
  'scripts/core/layer-map.json': 'scripts/core/layer-map.ts',
}

interface Packed {
  root: string
  files: string[]
  installed: string
  prefix: string
}

let packed: Packed

function builtPathOf(source: string): string {
  return path.join(OUT_DIR, source.replace(/\.ts$/, '.js'))
}

function cleanEnv(root: string, home: string): NodeJS.ProcessEnv {
  const homeDir = path.join(root, home)
  mkdirSync(homeDir, { recursive: true })
  return { PATH: process.env.PATH, HOME: homeDir, CONSTRUCT_BUS_DB: path.join(root, `${home}.bus.db`) }
}

function npmEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' }
}

function isPacked(file: string): boolean {
  return packed.files.some(packedFile => packedFile === file || packedFile.startsWith(`${file}/`))
}

async function bundledSources(entries: readonly string[], outDir: string): Promise<string[]> {
  await build({ entry: [...entries], format: ['esm'], platform: 'node', target: productBuild.target, bundle: true, skipNodeModulesBundle: true, metafile: true, outDir, silent: true, config: false })
  const { inputs } = JSON.parse(readFileSync(path.join(outDir, METAFILE), 'utf8')) as { inputs: Record<string, unknown> }
  return Object.keys(inputs).filter(input => SOURCE_ROOTS.test(input)).sort()
}

function builtFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(entry.parentPath, entry.name))
}

async function packAndInstall(): Promise<Packed> {
  const root = mkdtempSync(path.join(tmpdir(), 'package-factory-'))
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  const env = npmEnv(root)
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env, encoding: 'utf8' })) as { filename: string, files: { path: string }[] }[]
  const prefix = path.join(root, 'prefix')
  execFileSync('npm', ['install', '--global', '--prefix', prefix, path.join(root, tarball.filename), '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env, encoding: 'utf8' })
  return { root, files: tarball.files.map(file => file.path), installed: path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME), prefix }
}

describe('what the factory build reaches from its entries', () => {
  it('follows static, dynamic and double-quoted imports, never a type-only one', () => {
    const text = 'import type { A } from \'./types.js\'\nimport { b } from "./b.js"\nexport * from \'../c.js\'\nconst d = await import(\'./d.js\')\n'
    expect(importsOf('scripts/bus/x.ts', text).sort()).toEqual(['scripts/bus/b.ts', 'scripts/bus/d.ts', 'scripts/c.ts'])
  })

  it('follows a script the code names to spawn, and never a test source', () => {
    expect(scriptsNamedBy('const CLI = \'scripts/shift/brief-finish-cli.ts\'\nconst T = \'scripts/tests/bus/x.test.ts\'\nconst run = `pnpm exec node --import tsx scripts/ci/prepush.ts, which runs`')).toEqual(['scripts/shift/brief-finish-cli.ts', 'scripts/ci/prepush.ts'])
  })

  it('takes a quoted repository path to a file that is not a script as an asset, and never a test source', () => {
    const text = 'export const LAYER_MAP = \'scripts/core/layer-map.json\'\nconst CLI = \'scripts/shift/brief-finish-cli.ts\'\nconst F = "scripts/tests/fixtures/x.json"\n'
    expect(assetsNamedBy(text)).toEqual(['scripts/core/layer-map.json'])
  })

  it('locates a file read beside the module, directly or through a root constant, and drops the root itself and installed dependencies', () => {
    const text = [
      'const REPO_ROOT = path.resolve(import.meta.dirname, \'../..\')',
      'const header = readFileSync(path.join(import.meta.dirname, \'..\', \'shift\', \'header.md\'), \'utf8\')',
      'const HOOK = path.join(REPO_ROOT, \'.claude\', \'hooks\', \'eddies-measure.mjs\')',
      'const CRUISER = path.join(REPO_ROOT, \'node_modules\', \'dependency-cruiser\', \'bin\', \'dependency-cruiser.mjs\')',
    ].join('\n')
    expect(locatedBy('scripts/bus/x.ts', text).sort()).toEqual(['.claude/hooks/eddies-measure.mjs', 'scripts/shift/header.md'])
  })

  it('has an entry started from the package for every factory directory, and every started entry is a factory entry', () => {
    const entries = factoryEntries()
    expect(FACTORY_DIRECTORIES.filter(directory => !Object.keys(STARTS).some(entry => entry.startsWith(`scripts/${directory}/`)))).toEqual([])
    expect(Object.keys(STARTS).filter(entry => !entries.includes(entry))).toEqual([])
  })

  it('reaches every script the factory spawns and every file it reads beside a module', () => {
    const graph = factoryGraph()
    const assets = factoryAssets()
    expect(Object.entries(SPAWNED_BY_THE_FACTORY).filter(([spawned, by]) => !graph.includes(spawned) || !graph.includes(by)).map(([spawned]) => spawned)).toEqual([])
    expect(Object.entries(READ_BESIDE_THE_MODULE).filter(([asset, by]) => !assets.includes(asset) || !graph.includes(by)).map(([asset]) => asset)).toEqual([])
  })
})

describe('the factory in the published package', () => {
  beforeAll(async () => {
    packed = await packAndInstall()
  }, PACK_TIMEOUT_MS)

  afterAll(() => {
    if (packed !== undefined)
      rmSync(packed.root, { recursive: true, force: true })
  })

  it('npm pack installed into a clean prefix starts the built factory entry without tsx and without the repository sources', () => {
    expect(existsSync(path.join(packed.prefix, 'lib', 'node_modules', TSX))).toBe(false)
    expect(existsSync(path.join(packed.installed, 'node_modules', TSX))).toBe(false)
    expect(packed.files.filter(file => file.endsWith('.ts') && !file.startsWith(TEMPLATES))).toEqual([])
    expect(existsSync(path.join(packed.installed, 'scripts'))).toBe(false)
    expect(existsSync(path.join(packed.installed, 'src'))).toBe(false)

    const env = cleanEnv(packed.root, 'home-entry')
    const run = spawnSync(process.execPath, [path.join(packed.installed, builtPathOf(OWNER_SAY_ENTRY)), SAID], { cwd: packed.root, env, encoding: 'utf8' })

    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.startsWith(PREFIX)).toBe(true)
    const said = run.stdout.slice(PREFIX.length).trim()
    expect(path.dirname(said)).toBe(ownerChannelOf(env.HOME!))
    expect(said.endsWith(UNUSED_WORD)).toBe(true)
    expect(readFileSync(said, 'utf8')).toContain(SAID)
  })

  it('the packed tarball holds every module the factory entry imports', async () => {
    const entries = factoryEntries()
    expect(entries).toContain(OWNER_SAY_ENTRY)
    const imported = await bundledSources(entries, path.join(packed.root, 'bundle-entries'))
    const launched = await bundledSources(factoryGraph().filter(source => source.startsWith('scripts/')), path.join(packed.root, 'bundle-launched'))
    expect([...new Set([...imported, ...launched])].filter(source => !packed.files.includes(builtPathOf(source)))).toEqual([])
    expect(Object.keys(READ_BESIDE_THE_MODULE).filter(asset => !isPacked(path.join(OUT_DIR, asset)))).toEqual([])
    expect(factoryAssets().filter(asset => !isPacked(path.join(OUT_DIR, asset)))).toEqual([])

    const modules = imported.filter(source => !entries.includes(source)).map(source => pathToFileURL(path.join(packed.installed, builtPathOf(source))).href)
    const evaluate = 'const failed = []; for (const url of JSON.parse(process.env.MODULES)) { try { await import(url) } catch (error) { failed.push(url + \': \' + error.message) } } console.log(JSON.stringify(failed))'
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', evaluate], { cwd: packed.root, env: { ...cleanEnv(packed.root, 'home-imports'), MODULES: JSON.stringify(modules) }, encoding: 'utf8' })

    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout) as string[]).toEqual([])
  }, PACK_TIMEOUT_MS)

  it('holds the built twin of every script path the packed code names', () => {
    const named = builtFiles(path.join(packed.installed, OUT_DIR))
      .flatMap(file => [...readFileSync(file, 'utf8').replaceAll(BUNDLER_SOURCE_COMMENT, '').matchAll(SCRIPT_PATH_IN_BUILT_CODE)].map(([, script]) => script!))
      .filter(script => !script.startsWith(TEST_SOURCES) && existsSync(path.join(REPOSITORY, script)))
    expect(named.length).toBeGreaterThan(0)
    expect([...new Set(named)].filter(script => !packed.files.includes(builtPathOf(script)))).toEqual([])
    expect(Object.keys(SPAWNED_BY_THE_FACTORY).filter(script => !packed.files.includes(builtPathOf(script)))).toEqual([])
  })

  it.each(Object.entries(STARTS))('starts %s with plain node from the installed package and runs its main', (entry, { args, exit, prints }) => {
    const env = cleanEnv(packed.root, `home-${path.basename(entry, '.ts')}`)
    const run = spawnSync(process.execPath, [path.join(packed.installed, builtPathOf(entry)), ...args], { cwd: packed.root, env, encoding: 'utf8', input: '' })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(exit)
    expect(`${run.stdout}${run.stderr}`).toContain(prints)
  })

  it('construct say from the installed bin writes the owner\'s words, and only them, into the owner channel', () => {
    const env = cleanEnv(packed.root, 'home-cli')
    const run = spawnSync(path.join(packed.prefix, 'bin', 'construct'), ['say', SAID_THROUGH_THE_CLI, '--plain'], { cwd: packed.root, env, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const channel = ownerChannelOf(env.HOME!)
    const said = readdirSync(channel)
    expect(said).toHaveLength(1)
    expect(said[0]!.endsWith(UNUSED_WORD)).toBe(true)
    expect(run.stdout).toContain(path.join(channel, said[0]!))
    expect(readFileSync(path.join(channel, said[0]!), 'utf8').split('\n').slice(1)).toContain(SAID_THROUGH_THE_CLI)

    const empty = spawnSync(path.join(packed.prefix, 'bin', 'construct'), ['say', '--plain'], { cwd: packed.root, env, encoding: 'utf8' })
    expect(empty.status).toBe(2)
    expect(readdirSync(channel)).toHaveLength(1)
  })
})
