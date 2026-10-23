import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ownerChannelOf, UNUSED_WORD } from '../scripts/owner/channel.js'
import { PREFIX } from '../scripts/owner/say.js'
import { copyFactoryAssets, FACTORY_ASSETS, factoryBuild, factoryEntries, factoryGraph, OUT_DIR, productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const TEMPLATES = 'templates/'
const PACKED_BESIDE_THE_BUILD = ['package.json', 'README.md', 'LICENSE', 'templates']
const OWNER_SAY_ENTRY = 'scripts/owner/say.ts'
const SAID = 'the factory starts from the package'
const TSX = 'tsx'
const PACK_TIMEOUT_MS = 300_000

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

function cleanEnv(root: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: path.join(root, 'home'), CONSTRUCT_BUS_DB: path.join(root, 'bus.db') }
}

function npmEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' }
}

async function packAndInstall(): Promise<Packed> {
  const root = mkdtempSync(path.join(tmpdir(), 'package-factory-'))
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  mkdirSync(cleanEnv(root).HOME!, { recursive: true })
  const env = npmEnv(root)
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env, encoding: 'utf8' })) as { filename: string, files: { path: string }[] }[]
  const prefix = path.join(root, 'prefix')
  execFileSync('npm', ['install', '--global', '--prefix', prefix, path.join(root, tarball.filename), '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env, encoding: 'utf8' })
  return { root, files: tarball.files.map(file => file.path), installed: path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME), prefix }
}

beforeAll(async () => {
  packed = await packAndInstall()
}, PACK_TIMEOUT_MS)

afterAll(() => {
  if (packed !== undefined)
    rmSync(packed.root, { recursive: true, force: true })
})

describe('the factory in the published package', () => {
  it('npm pack installed into a clean prefix starts the built factory entry without tsx and without the repository sources', () => {
    expect(existsSync(path.join(packed.prefix, 'lib', 'node_modules', TSX))).toBe(false)
    expect(existsSync(path.join(packed.installed, 'node_modules', TSX))).toBe(false)
    expect(packed.files.filter(file => file.endsWith('.ts') && !file.startsWith(TEMPLATES))).toEqual([])
    expect(existsSync(path.join(packed.installed, 'scripts'))).toBe(false)
    expect(existsSync(path.join(packed.installed, 'src'))).toBe(false)

    const env = cleanEnv(packed.root)
    const run = spawnSync(process.execPath, [path.join(packed.installed, builtPathOf(OWNER_SAY_ENTRY)), SAID], { cwd: packed.root, env, encoding: 'utf8' })

    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.startsWith(PREFIX)).toBe(true)
    const said = run.stdout.slice(PREFIX.length).trim()
    expect(path.dirname(said)).toBe(ownerChannelOf(env.HOME!))
    expect(said.endsWith(UNUSED_WORD)).toBe(true)
    expect(readFileSync(said, 'utf8')).toContain(SAID)
  })

  it('the packed tarball holds every module the factory entry imports', () => {
    const entries = factoryEntries()
    const graph = factoryGraph(entries)
    expect(entries).toContain(OWNER_SAY_ENTRY)
    expect(graph.filter(source => !packed.files.includes(builtPathOf(source)))).toEqual([])
    expect(FACTORY_ASSETS.filter(asset => !packed.files.some(file => file === path.join(OUT_DIR, asset) || file.startsWith(`${path.join(OUT_DIR, asset)}/`)))).toEqual([])

    const imported = graph.filter(source => !entries.includes(source)).map(source => pathToFileURL(path.join(packed.installed, builtPathOf(source))).href)
    const evaluate = 'const failed = []; for (const url of JSON.parse(process.env.MODULES)) { try { await import(url) } catch (error) { failed.push(url + \': \' + error.message) } } console.log(JSON.stringify(failed))'
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', evaluate], { cwd: packed.root, env: { ...cleanEnv(packed.root), MODULES: JSON.stringify(imported) }, encoding: 'utf8' })

    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout) as string[]).toEqual([])
  })
})
