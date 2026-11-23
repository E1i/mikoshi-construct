import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FACTORY_RUNTIME, FACTORY_WORKERS } from '../scripts/core/factory-paths.js'
import { readLayerMap } from '../scripts/core/layer-map.js'
import { PLANNER_ARGUMENTS, REVIEW_PLANNER_SCRIPT } from '../scripts/ports/review-planner.js'
import { OWNED_ATLAS_PAGE } from '../src/atlas/index.js'
import { ATTACH_RUNTIME_BROWSER, ATTACH_RUNTIME_FILES, ATTACH_RUNTIME_RUN_DIRECTORY, ATTACH_RUNTIME_SHOT_SUFFIX, ATTACH_WRITES } from '../src/commands/attach/carriers.js'
import { ATTACH_RECORD_FILE } from '../src/commands/attach/record.js'
import { LEDGER_FILE, STEP_CACHE_FILE } from '../src/commands/cost/index.js'
import { copyFactoryAssets, factoryAssets, factoryBuild, factoryGraph, OUT_DIR } from '../tsup.config.js'

const ROOT = path.join(import.meta.dirname, '..')
const BUILD_TIMEOUT_MS = 300_000
const SOURCE_MODULE = /\.ts$/
const BUILT_MODULE = '.js'
const WORKER_NAMED_BY_URL = /new URL\(\s*'(\.{1,2}\/[^']*\.ts)',\s*import\.meta\.url\s*\)/g
const BESIDE_THE_BUILD = ['package.json', 'declarations/generated', 'templates']
const SOURCE_LOADER = 'tsx'
const REVIEW_PLANNER_PORT = 'scripts/ports/review-planner.ts'
const LAYER_MAP_READER = 'scripts/core/layer-map.ts'
const DAEMON_COMMANDS_READER = 'src/commands/attach/daemon-commands.ts'

function twinOf(source: string): string {
  return source.replace(SOURCE_MODULE, BUILT_MODULE)
}

interface BuiltReadings {
  script: string
  args: string[]
  globals: string[]
  folders: Record<string, string>
}

let stage: string
let dist: string

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

const WRITERS: Record<string, string> = {
  [LEDGER_FILE]: read('src/commands/cost/ledger.ts'),
  [STEP_CACHE_FILE]: read('src/commands/cost/step-cache.ts'),
  '.construct/implement-agreed.txt': read('templates/ai/claude/_claude/skills/implement/SKILL.md'),
  '.construct/implement-args.json': read('templates/ai/claude/_claude/skills/implement/SKILL.md'),
  [OWNED_ATLAS_PAGE]: read('src/atlas/index.ts'),
}

function readFromTheBuild(): BuiltReadings {
  const modules = { port: pathToFileURL(path.join(dist, twinOf(REVIEW_PLANNER_PORT))).href, layers: pathToFileURL(path.join(dist, twinOf(LAYER_MAP_READER))).href }
  const evaluate = [
    'const { port, layers } = JSON.parse(process.env.MODULES)',
    'const { PLANNER_ARGUMENTS, REVIEW_PLANNER_SCRIPT } = await import(port)',
    'const { globals, folders } = (await import(layers)).readLayerMap()',
    'console.log(JSON.stringify({ script: REVIEW_PLANNER_SCRIPT, args: PLANNER_ARGUMENTS, globals, folders }))',
  ].join('\n')
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', evaluate], { cwd: stage, env: { PATH: process.env.PATH, HOME: stage, MODULES: JSON.stringify(modules) }, encoding: 'utf8' })
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as BuiltReadings
}

function daemonCommandsOf(module: string, loader: string[]): string[] {
  const evaluate = 'const { shippedDaemonCommands } = await import(process.env.READER); console.log(JSON.stringify(shippedDaemonCommands(process.env.HOME)))'
  const run = spawnSync(process.execPath, [...loader, '--input-type=module', '--eval', evaluate], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: stage, TMPDIR: tmpdir(), READER: pathToFileURL(module).href }, encoding: 'utf8' })
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as string[]
}

describe('every runtime file and worker path resolves the same from the sources and from dist', () => {
  beforeAll(async () => {
    stage = realpathSync(mkdtempSync(path.join(tmpdir(), 'runtime-paths-')))
    for (const file of BESIDE_THE_BUILD)
      cpSync(path.join(ROOT, file), path.join(stage, file), { recursive: true })
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(stage, 'node_modules'), 'dir')
    dist = path.join(stage, OUT_DIR)
    await build({ ...factoryBuild, outDir: dist, config: false, silent: true, onSuccess: async () => copyFactoryAssets(dist) })
  }, BUILD_TIMEOUT_MS)

  afterAll(() => {
    if (stage !== undefined)
      rmSync(stage, { recursive: true, force: true })
  })

  it('every runtime file and worker path resolves the same from the sources and from dist', () => {
    const declared = [...Object.values(FACTORY_RUNTIME), ...Object.values(FACTORY_WORKERS)]
    expect(declared.filter(file => !existsSync(path.join(dist, twinOf(file))))).toEqual([])
    expect(factoryAssets().filter(asset => !existsSync(path.join(dist, asset)))).toEqual([])

    const namedByUrl = factoryGraph().flatMap(source => [...readFileSync(path.join(ROOT, source), 'utf8').matchAll(WORKER_NAMED_BY_URL)]
      .map(([, relative]) => path.posix.join(path.posix.dirname(source), relative!)))
    expect(namedByUrl.length).toBeGreaterThan(0)
    expect(namedByUrl.filter(worker => !existsSync(path.join(ROOT, worker)) || !existsSync(path.join(dist, twinOf(worker))))).toEqual([])

    const built = readFromTheBuild()
    expect(path.relative(dist, built.script)).toBe(twinOf(path.relative(ROOT, REVIEW_PLANNER_SCRIPT)))
    expect(existsSync(built.script)).toBe(true)
    expect(built.args).not.toContain(SOURCE_LOADER)
    expect(PLANNER_ARGUMENTS).toContain(SOURCE_LOADER)
    expect(existsSync(REVIEW_PLANNER_SCRIPT)).toBe(true)

    const fromTheSources = readLayerMap()
    expect(built.globals).toEqual(fromTheSources.globals)
    expect(built.folders).toEqual(fromTheSources.folders)
  })

  it('the factory build finds the shipped templates and reads the same daemon commands as the sources', () => {
    const fromTheBuild = daemonCommandsOf(path.join(dist, twinOf(DAEMON_COMMANDS_READER)), [])
    const fromTheSources = daemonCommandsOf(path.join(ROOT, DAEMON_COMMANDS_READER), ['--import', SOURCE_LOADER])
    expect(fromTheSources.length).toBeGreaterThan(0)
    expect(fromTheBuild).toEqual(fromTheSources)
  })
})

describe('the closed list of runtime files is what the ladder writes under .construct/', () => {
  it('names a writer for every file on the list, and a list member for every writer', () => {
    expect([...ATTACH_RUNTIME_FILES].sort()).toEqual(Object.keys(WRITERS).sort())
    for (const [name, writer] of Object.entries(WRITERS))
      expect(writer, name).toContain(name)
  })

  it('keeps the run directory pattern, the browser directory and the png suffix the browser witness writes', () => {
    const writer = read('scripts/construct/browser-witness.mjs')

    expect(writer).toContain(`RUN_DIRECTORY = ${ATTACH_RUNTIME_RUN_DIRECTORY}`)
    expect(writer).toContain(ATTACH_RUNTIME_BROWSER)
    expect(writer).toContain(ATTACH_RUNTIME_SHOT_SUFFIX)
  })

  it('lies under .construct/ and overlaps neither what attach writes nor its record', () => {
    for (const name of ATTACH_RUNTIME_FILES) {
      expect(name.startsWith('.construct/'), name).toBe(true)
      expect(ATTACH_WRITES, name).not.toContain(name)
      expect(name).not.toBe(ATTACH_RECORD_FILE)
    }
    expect(ATTACH_WRITES).not.toContain(ATTACH_RUNTIME_BROWSER)
  })
})
