import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, describe, expect, it } from 'vitest'
import { copyFactoryAssets, factoryBuild, OUT_DIR, productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const PACKED_BESIDE_THE_BUILD = ['package.json', 'README.md', 'LICENSE', 'templates']
const PACK_TIMEOUT_MS = 300_000
const REGISTRY_MODULE = 'scripts/core/factory-paths.js'
const TYPESCRIPT = '.ts'
const TARBALL_ROOT = 'package'

const OPENERS: Record<string, { module: string, exported: string }> = {
  'the window session': { module: 'scripts/ports/client/claude/adapter.js', exported: 'WINDOW_MCP_CONFIG' },
  'the launch node': { module: 'scripts/nodes/launch/launch-root.js', exported: 'HEADER_FILE' },
  'the supervisor liveness check': { module: 'scripts/supervisor/liveness-sites.js', exported: 'KNOWN_LIVENESS_SITES' },
  'the layer map reader': { module: 'scripts/core/layer-map.js', exported: 'LAYER_MAP' },
}

interface Installed {
  root: string
  scratch: string
  dist: string
}

interface Opened {
  runtime: Record<string, string>
  exports: Record<string, string>
}

let installed: Installed | undefined

function npmEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' }
}

function linkDependenciesFromTheRepository(modules: string): void {
  const { dependencies = {} } = JSON.parse(readFileSync(path.join(modules, PACKAGE_NAME, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  for (const dependency of Object.keys(dependencies)) {
    const link = path.join(modules, dependency)
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(path.join(REPOSITORY, 'node_modules', dependency), link, 'dir')
  }
}

async function packIntoScratchRepository(): Promise<Installed> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'packed-path-opened-')))
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  const env = npmEnv(root)
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env, encoding: 'utf8' })) as { filename: string }[]
  const scratch = path.join(root, 'scratch')
  const modules = path.join(scratch, 'node_modules')
  mkdirSync(modules, { recursive: true })
  writeFileSync(path.join(scratch, 'package.json'), `${JSON.stringify({ name: 'scratch', private: true }, null, 2)}\n`)
  execFileSync('tar', ['-xzf', path.join(root, tarball!.filename), '-C', modules])
  renameSync(path.join(modules, TARBALL_ROOT), path.join(modules, PACKAGE_NAME))
  linkDependenciesFromTheRepository(modules)
  return { root, scratch, dist: path.join(scratch, 'node_modules', PACKAGE_NAME, OUT_DIR) }
}

function openedFromThePackage(installed: Installed): Opened {
  const modules = { registry: pathToFileURL(path.join(installed.dist, REGISTRY_MODULE)).href, openers: Object.fromEntries(Object.values(OPENERS).map(({ module, exported }) => [exported, pathToFileURL(path.join(installed.dist, module)).href])) }
  const evaluate = [
    'const { registry, openers } = JSON.parse(process.env.MODULES)',
    'const { FACTORY_RUNTIME } = await import(registry)',
    'const exports = {}',
    'for (const [name, url] of Object.entries(openers)) exports[name] = (await import(url))[name]',
    'console.log(JSON.stringify({ runtime: FACTORY_RUNTIME, exports }))',
  ].join('\n')
  const home = path.join(installed.root, 'home')
  mkdirSync(home, { recursive: true })
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', evaluate], { cwd: installed.scratch, env: { PATH: process.env.PATH, HOME: home, MODULES: JSON.stringify(modules) }, encoding: 'utf8' })
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as Opened
}

describe('path-opened assets in the published package', () => {
  afterAll(() => {
    if (installed !== undefined)
      rmSync(installed.root, { recursive: true, force: true })
  })

  it('the packed tarball installed into a scratch repository opens every path-opened asset of the window and bus entries', async () => {
    installed = await packIntoScratchRepository()
    const { dist } = installed
    const { runtime, exports } = openedFromThePackage(installed)
    const assets = Object.values(runtime).filter(file => !file.endsWith(TYPESCRIPT))
    expect(assets.length).toBeGreaterThan(0)
    expect(assets.filter(asset => !existsSync(path.join(dist, asset)))).toEqual([])
    const openedPaths = Object.entries(OPENERS).map(([opener, { exported }]) => [opener, path.isAbsolute(exports[exported]!) ? exports[exported]! : path.join(dist, exports[exported]!)] as const)
    expect(openedPaths.filter(([, opened]) => !existsSync(opened) || path.relative(dist, opened).startsWith('..')).map(([opener, opened]) => `${opener}: ${opened}`)).toEqual([])
    expect(existsSync(path.join(dist, 'scripts', 'window', 'window-mcp.json'))).toBe(true)
  }, PACK_TIMEOUT_MS)
})
