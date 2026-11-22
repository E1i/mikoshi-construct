import type { SpawnSyncReturns } from 'node:child_process'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FACTORY_FORMER_FOLDERS, FACTORY_NAMED, FACTORY_RUNTIME } from '../scripts/core/factory-paths.js'
import { ownerChannelOfBus, UNUSED_WORD } from '../scripts/owner/channel.js'
import { USAGE as OWNER_SAY_USAGE, PREFIX } from '../scripts/owner/say.js'
import { USAGE as SHARD_USAGE } from '../scripts/policy/shard.js'
import { USAGE as FACTORY_START_USAGE } from '../scripts/supervisor/start.js'
import { USAGE as MIKO_WATCH_USAGE } from '../scripts/window/watch.js'
import { assetsNamedBy, copyFactoryAssets, FACTORY_DIRECTORIES, factoryAssets, factoryBuild, factoryEntries, factoryGraph, generatedRecordsReadBy, importsOf, locatedBy, OUT_DIR, productBuild, scriptsNamedBy } from '../tsup.config.js'

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
  'scripts/core/reducer.ts': { args: [], exit: 0, prints: 'applied 0, rejected 0' },
  'scripts/cli/slot.ts': { args: [], exit: 1, prints: '[bus:slot] the kind is one of quality | vitest' },
  'scripts/intake/import.ts': { args: [], exit: 1, prints: '[bus:import] no journal at' },
  'scripts/nodes/close/task-close.ts': { args: [], exit: 1, prints: '[task:close] one task id is needed' },
  'scripts/ports/task-start.ts': { args: [], exit: 1, prints: '[task:start] a task starts from its card now' },
  'scripts/supervisor/start.ts': { args: ['--bogus'], exit: 2, prints: FACTORY_START_USAGE },
  'scripts/policy/decisions/read.ts': { args: [], exit: 1, prints: '[decisions] no decisions at' },
  'scripts/ladder/role.ts': { args: ['review', '--task', 't1'], exit: 0, prints: 'local: launch the review agent for t1' },
  'scripts/window/watch.ts': { args: ['--bogus'], exit: 2, prints: MIKO_WATCH_USAGE },
  'scripts/owner/say.ts': { args: [], exit: 2, prints: OWNER_SAY_USAGE },
  'scripts/policy/shard.ts': { args: [], exit: 1, prints: SHARD_USAGE },
}

const SPAWNED_BY_THE_FACTORY: Record<string, string> = {
  'scripts/ladder/brief-finish-cli.ts': 'scripts/ladder/ladder-starter.ts',
  'scripts/nodes/launch/tree-pr-cli.ts': 'scripts/nodes/launch/launch-starter.ts',
  'scripts/attach/earlier-carriers.ts': 'scripts/ports/witnesses.ts',
  'scripts/ci/prepush.ts': 'scripts/nodes/answer/answerer.ts',
  'scripts/ci/sandbox-trace.ts': 'scripts/ci/sandbox-liveness.ts',
}

const NAMED_BUT_NEVER_RUN_BY_THE_FACTORY: string[] = [FACTORY_NAMED.ghCallers]
const FORMER_FOLDER_ENTRIES: string[] = Object.values(FACTORY_FORMER_FOLDERS).flat()

const READ_BESIDE_THE_MODULE: Record<string, string> = {
  'scripts/nodes/launch/header.md': 'scripts/nodes/launch/launch-root.ts',
  'scripts/construct/check-acceptance.mjs': 'scripts/ladder/hash.ts',
  '.claude/hooks/eddies-measure.mjs': 'scripts/window/eddies-measure.ts',
  'scripts/ci/sandbox-trace-child.mjs': 'scripts/ci/sandbox-trace.ts',
  'scripts/ci/sandbox-failing.jsonl': 'scripts/ci/sandbox-failing.ts',
  'contract/contours': 'scripts/contract/contours.ts',
  'scripts/core/layer-map.json': 'scripts/core/layer-map.ts',
}

const OPENED_BY_PATH: Record<string, string> = {
  windowMcpConfig: 'scripts/ports/client/claude/adapter.ts',
  shiftHeader: 'scripts/nodes/launch/launch-root.ts',
  knownLivenessSites: 'scripts/supervisor/liveness-sites.ts',
  layerMap: 'scripts/core/layer-map.ts',
}

const PATH_BESIDE_AN_ENTRY = /path\.dirname\(FACTORY_\w+\.\w+\)/

const REVIEW_PLANNER_PORT = 'scripts/ports/review-planner.ts'
const REVIEW_WORKER = 'scripts/nodes/review/review-worker.ts'
const MERGE_WORKER = 'scripts/nodes/merge/merge-worker.ts'
const LAYER_MAP_READER = 'scripts/core/layer-map.ts'
const PLANNER_TIMEOUT_MS = 60_000
const UNKNOWN_HEAD_LEASE = { taskKey: 'review:1:consumer', queue: 'review', cardId: 1, pr: null, head: null, leaseGen: 1, actor: 'worker:review' }
const ANSWERED_CARD = '#1'
const ANSWER_WORDS = 'go on from the package'
const ANSWER_BIN = 'construct-answer'
const TARBALL_ROOT = 'package'
const OWNER_ANSWER_REQUEST = `owner.answer ${ANSWERED_CARD}`
const MISSING_FILE = /ENOENT|ERR_MODULE_NOT_FOUND|Cannot find module/

interface ConsumerRun {
  script: string
  args: string[]
  plan: { depth: string }
  childPlan: { depth: string }
  globals: number
}

interface Packed {
  root: string
  files: string[]
  installed: string
  prefix: string
}

interface Tarball {
  root: string
  file: string
  files: string[]
}

interface Consumer {
  root: string
  directory: string
  installed: string
  files: string[]
}

let packed: Packed
let consumer: Consumer

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

function reviewFromTheConsumer(consumer: Consumer): { run: SpawnSyncReturns<string>, read: () => ConsumerRun } {
  const modules = {
    port: pathToFileURL(path.join(consumer.installed, builtPathOf(REVIEW_PLANNER_PORT))).href,
    worker: pathToFileURL(path.join(consumer.installed, builtPathOf(REVIEW_WORKER))).href,
    layers: pathToFileURL(path.join(consumer.installed, builtPathOf(LAYER_MAP_READER))).href,
  }
  const evaluate = [
    'const { port, worker, layers } = JSON.parse(process.env.MODULES)',
    'const { PLANNER_ARGUMENTS, plannerProcess, REVIEW_PLANNER_SCRIPT } = await import(port)',
    'const { childReviewPlanner } = await import(worker)',
    'const { readLayerMap } = await import(layers)',
    'const signal = AbortSignal.timeout(Number(process.env.PLANNER_TIMEOUT_MS))',
    'const lease = JSON.parse(process.env.LEASE)',
    'const printed = await plannerProcess(process.cwd(), JSON.stringify({ lease, earlier: null }), signal)',
    'const plan = JSON.parse(printed.trim().split(\'\\n\').at(-1))',
    'const childPlan = await childReviewPlanner(process.cwd())(lease, null, signal)',
    'console.log(JSON.stringify({ script: REVIEW_PLANNER_SCRIPT, args: PLANNER_ARGUMENTS, plan, childPlan, globals: readLayerMap().globals.length }))',
  ].join('\n')
  const env = { ...cleanEnv(consumer.root, `home-${path.basename(consumer.directory)}`), MODULES: JSON.stringify(modules), LEASE: JSON.stringify(UNKNOWN_HEAD_LEASE), PLANNER_TIMEOUT_MS: String(PLANNER_TIMEOUT_MS) }
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', evaluate], { cwd: consumer.directory, env, encoding: 'utf8' })
  return { run, read: () => JSON.parse(run.stdout) as ConsumerRun }
}

async function packTarball(prefix: string): Promise<Tarball> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env: npmEnv(root), encoding: 'utf8' })) as { filename: string, files: { path: string }[] }[]
  return { root, file: path.join(root, tarball!.filename), files: tarball!.files.map(file => file.path) }
}

async function packAndInstall(): Promise<Packed> {
  const { root, file, files } = await packTarball('package-factory-')
  const prefix = path.join(root, 'prefix')
  execFileSync('npm', ['install', '--global', '--prefix', prefix, file, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env: npmEnv(root), encoding: 'utf8' })
  return { root, files, installed: path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME), prefix }
}

async function packIntoAnEmptyConsumer(): Promise<Consumer> {
  const { root, file, files } = await packTarball('package-consumer-')
  const directory = path.join(root, 'consumer')
  const modules = path.join(directory, 'node_modules')
  mkdirSync(modules, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name: 'consumer', private: true }, null, 2)}\n`)
  execFileSync('tar', ['-xzf', file, '-C', modules])
  renameSync(path.join(modules, TARBALL_ROOT), path.join(modules, PACKAGE_NAME))
  const installed = path.join(modules, PACKAGE_NAME)
  const { dependencies = {} } = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  for (const dependency of Object.keys(dependencies)) {
    const link = path.join(modules, dependency)
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(path.join(REPOSITORY, 'node_modules', dependency), link, 'dir')
  }
  return { root, directory, installed, files }
}

describe('what the factory build reaches from its entries', () => {
  it('follows static, dynamic and double-quoted imports, never a type-only one', () => {
    const text = 'import type { A } from \'./types.js\'\nimport { b } from "./b.js"\nexport * from \'../c.js\'\nconst d = await import(\'./d.js\')\n'
    expect(importsOf('scripts/bus/x.ts', text).sort()).toEqual(['scripts/bus/b.ts', 'scripts/bus/d.ts', 'scripts/c.ts'])
  })

  it('follows a script the code names to spawn, and never a test source', () => {
    expect(scriptsNamedBy('const CLI = \'scripts/ladder/brief-finish-cli.ts\'\nconst T = \'scripts/tests/bus/x.test.ts\'\nconst run = `pnpm exec node --import tsx scripts/ci/prepush.ts, which runs`')).toEqual(['scripts/ladder/brief-finish-cli.ts', 'scripts/ci/prepush.ts'])
  })

  it('takes a quoted repository path to a file that is not a script as an asset, and never a test source', () => {
    const text = 'export const LAYER_MAP = \'scripts/core/layer-map.json\'\nconst CLI = \'scripts/ladder/brief-finish-cli.ts\'\nconst F = "scripts/tests/fixtures/x.json"\n'
    expect(assetsNamedBy(text)).toEqual(['scripts/core/layer-map.json'])
  })

  it('locates a file read beside the module, directly or through a root constant, and drops the root itself and installed dependencies', () => {
    const text = [
      'const REPO_ROOT = path.resolve(import.meta.dirname, \'../..\')',
      'const header = readFileSync(path.join(import.meta.dirname, \'launch\', \'header.md\'), \'utf8\')',
      'const HOOK = path.join(REPO_ROOT, \'.claude\', \'hooks\', \'eddies-measure.mjs\')',
      'const CRUISER = path.join(REPO_ROOT, \'node_modules\', \'dependency-cruiser\', \'bin\', \'dependency-cruiser.mjs\')',
    ].join('\n')
    expect(locatedBy('scripts/nodes/x.ts', text).sort()).toEqual(['.claude/hooks/eddies-measure.mjs', 'scripts/nodes/launch/header.md'])
  })

  it('locates a worker named by a URL beside the module', () => {
    const text = 'const PLANNER = fileURLToPath(new URL(\'../nodes/review/review-planner-worker.ts\', import.meta.url))\nconst ROOT = fileURLToPath(new URL(\'../..\', import.meta.url))'
    expect(locatedBy('scripts/ports/x.ts', text)).toEqual(['scripts/nodes/review/review-planner-worker.ts'])
  })

  it('takes a generated record a module reads from its own location as an asset, and never a generated source or a record named without that anchor', () => {
    expect(generatedRecordsReadBy('const ROOT = path.resolve(import.meta.dirname, \'..\', \'..\')\nconst RECORD = GENERATED_FILES.factory.path\nconst OWNS = GENERATED_FILES.moduleOwns.path')).toEqual(['contract/factory.json'])
    expect(generatedRecordsReadBy('export function read(tree: string) { return path.join(tree, GENERATED_FILES.factory.path) }')).toEqual([])
  })

  it('ships contract/factory.json and builds the review planner worker, the two files a consumer opened and could not find', () => {
    expect(factoryAssets()).toContain('contract/factory.json')
    expect(factoryGraph()).toContain('scripts/nodes/review/review-planner-worker.ts')
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

  it('every path-opened runtime asset is a declared runtime entry that copyFactoryAssets ships', () => {
    const runtime: Record<string, string> = FACTORY_RUNTIME
    const graph = factoryGraph()
    const assets = factoryAssets()
    expect(Object.keys(runtime).filter(entry => !runtime[entry]!.endsWith('.ts')).sort()).toEqual(Object.keys(OPENED_BY_PATH).sort())
    expect(assets).toContain(runtime.windowMcpConfig)
    expect(Object.entries(OPENED_BY_PATH).filter(([entry, opener]) => runtime[entry] === undefined
      || !assets.includes(runtime[entry]!)
      || !graph.includes(opener)
      || !readFileSync(path.join(REPOSITORY, opener), 'utf8').includes(`FACTORY_RUNTIME.${entry}`)).map(([entry]) => entry)).toEqual([])
  })

  it('no factory source builds a path to an asset beside another runtime entry', () => {
    expect(factoryGraph().filter(source => PATH_BESIDE_AN_ENTRY.test(readFileSync(path.join(REPOSITORY, source), 'utf8')))).toEqual([])
  })

  it('copies a plain .mjs module a factory script imports as it is, and never hands it to tsup as an entry', () => {
    const shared = path.join('.claude', 'hooks', 'tab-window.mjs')

    expect(factoryAssets()).toContain(shared)
    expect(factoryGraph()).not.toContain(shared)
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
    expect(path.dirname(said)).toBe(ownerChannelOfBus(env.HOME!, env.CONSTRUCT_BUS_DB!))
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
      .filter(script => !script.startsWith(TEST_SOURCES) && !FORMER_FOLDER_ENTRIES.includes(script) && existsSync(path.join(REPOSITORY, script)))
    expect(named.length).toBeGreaterThan(0)
    const unpackedNamed = Object.values<string>(FACTORY_NAMED).filter(script => script.endsWith('.ts') && !script.startsWith(TEST_SOURCES) && !packed.files.includes(builtPathOf(script)))
    expect(unpackedNamed).toEqual(NAMED_BUT_NEVER_RUN_BY_THE_FACTORY)
    expect([...new Set(named)].filter(script => !NAMED_BUT_NEVER_RUN_BY_THE_FACTORY.includes(script) && !packed.files.includes(builtPathOf(script)))).toEqual([])
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
    const channel = ownerChannelOfBus(env.HOME!, env.CONSTRUCT_BUS_DB!)
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

describe('the packed tarball in an empty consumer', () => {
  beforeAll(async () => {
    consumer = await packIntoAnEmptyConsumer()
  }, PACK_TIMEOUT_MS)

  afterAll(() => {
    if (consumer !== undefined)
      rmSync(consumer.root, { recursive: true, force: true })
  })

  it('the packed tarball installed into an empty consumer runs the review planner and reads contract/factory.json without ENOENT', () => {
    const { run, read } = reviewFromTheConsumer(consumer)

    expect(run.stderr).not.toMatch(MISSING_FILE)
    expect(run.status, run.stderr).toBe(0)
    const { script, args, plan, globals } = read()
    expect(path.relative(consumer.installed, script).startsWith('..')).toBe(false)
    expect(existsSync(script)).toBe(true)
    expect(script.endsWith('.js')).toBe(true)
    expect(args).not.toContain(TSX)
    expect(plan.depth).toBe('full')
    expect(globals).toBeGreaterThan(0)
    expect(consumer.files).toContain(path.join(OUT_DIR, 'contract', 'factory.json'))
  }, PACK_TIMEOUT_MS)

  it('the packed tarball installed into an empty consumer runs a review and an answer round, not only the start', () => {
    const { run, read } = reviewFromTheConsumer(consumer)
    expect(run.status, run.stderr).toBe(0)
    expect(read().childPlan.depth).toBe('full')

    const { bin } = JSON.parse(readFileSync(path.join(consumer.installed, 'package.json'), 'utf8')) as { bin: Record<string, string> }
    const env = cleanEnv(consumer.root, 'home-answer-round')
    const answer = spawnSync(process.execPath, [path.join(consumer.installed, bin[ANSWER_BIN]!), ANSWERED_CARD, ANSWER_WORDS], { cwd: consumer.directory, env, encoding: 'utf8' })
    expect(answer.stderr).not.toMatch(MISSING_FILE)
    expect(answer.status, `${answer.stdout}\n${answer.stderr}`).toBe(0)
    expect(answer.stdout).toContain(OWNER_ANSWER_REQUEST)
    expect(existsSync(env.CONSTRUCT_BUS_DB!)).toBe(true)
  }, PACK_TIMEOUT_MS)

  it('the packed tarball installed into an empty consumer rebuilds the catalog in the consumer repository or skips it with a reason, never runs git in the installed package', () => {
    const origin = path.join(consumer.root, 'consumer-origin.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    gitOfTheConsumer('init', '-q', '-b', 'main')
    writeFileSync(path.join(consumer.directory, '.gitignore'), 'node_modules\n')
    gitOfTheConsumer('add', 'package.json', '.gitignore')
    gitOfTheConsumer('commit', '-q', '-m', 'consumer')
    gitOfTheConsumer('remote', 'add', 'origin', origin)
    gitOfTheConsumer('push', '-q', 'origin', 'main')

    const worker = pathToFileURL(path.join(consumer.installed, builtPathOf(MERGE_WORKER))).href
    const evaluate = [
      'const { liveMergeRun } = await import(process.env.WORKER)',
      'const rebuilt = liveMergeRun(process.cwd(), process.env.CONSTRUCT_BUS_DB).rebuildCatalog(process.env.REF)',
      'console.log(JSON.stringify(rebuilt ?? null))',
    ].join('\n')
    const env = { ...cleanEnv(consumer.root, 'home-catalog-rebuild'), WORKER: worker, REF: 'origin/main' }
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', evaluate], { cwd: consumer.directory, env, encoding: 'utf8' })

    expect(run.stderr).not.toContain(consumer.installed)
    expect(run.status, run.stderr).toBe(0)
    const rebuilt = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { kind: string, reason?: string }
    expect(rebuilt.kind).toBe('skipped')
    expect(rebuilt.reason).toContain(realpathSync(consumer.directory))
    expect(rebuilt.reason).not.toContain('node_modules')
    expect(gitOfTheConsumer('worktree', 'list').trim().split('\n')).toHaveLength(1)
  }, PACK_TIMEOUT_MS)
})

function gitOfTheConsumer(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', consumer.directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
