import type { SpawnSyncReturns } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve('scripts/construct/browser-lab.mjs')
const source = readFileSync(SCRIPT, 'utf8')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const SHADOW_EXECUTED = 'shadow-executed'
const CACHED_CORE_LOADED = 'cached-core-loaded'
const CACHED_CLI_RAN = 'cached-cli-ran'

function markingLine(marker: string): string {
  return `writeFileSync(${JSON.stringify(marker)}, '')`
}

function chromiumLibrary(marker: string): string {
  return `import { writeFileSync } from 'node:fs'
${markingLine(marker)}
const page = { on() {}, goto: async () => ({ status: () => 200 }), title: async () => 'stub', evaluate: async () => '', screenshot: async () => {}, url: () => 'about:blank' }
const session = { on() {}, send: async () => ({}), detach: async () => {} }
const context = { newPage: async () => page, pages: () => [page], newCDPSession: async () => session, close: async () => {}, on() {}, route: async () => {}, serviceWorkers: () => [] }
export const chromium = { executablePath: () => ${JSON.stringify(marker)}, launchPersistentContext: async () => context }
`
}

function toolScript(marker: string): string {
  return `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
${markingLine(marker)}
`
}

function holdPackage(modules: string, name: string, version: string, bin: string, library: string, script: string): void {
  const directory = path.join(modules, name)
  mkdirSync(directory, { recursive: true })
  mkdirSync(path.join(modules, '.bin'), { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version, type: 'commonjs' }))
  writeFileSync(path.join(directory, 'index.mjs'), library)
  writeFileSync(path.join(directory, 'tool.js'), script)
  chmodSync(path.join(directory, 'tool.js'), 0o755)
  symlinkSync(path.join(directory, 'tool.js'), path.join(modules, '.bin', bin))
}

interface World {
  root: string
  home: string
  tree: string
  shadowBin: string
}

function world(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'browser-lab-shadow-')))
  roots.push(root)
  const home = path.join(root, 'home')
  const tree = path.join(root, 'tree')
  mkdirSync(home)
  mkdirSync(tree)
  const modules = path.join(tree, 'node_modules')
  const shadow = path.join(root, SHADOW_EXECUTED)
  holdPackage(modules, 'playwright-core', '1.62.1', 'playwright-core', chromiumLibrary(shadow), toolScript(shadow))
  holdPackage(modules, '@playwright/cli', '0.1.17', 'playwright-cli', '', toolScript(shadow))
  const shadowBin = path.join(modules, '.bin')
  writeFileSync(path.join(shadowBin, 'npx'), `#!/bin/sh\ntouch '${shadow}'\nexit 1\n`, { mode: 0o755 })
  writeFileSync(path.join(shadowBin, 'node'), `#!/bin/sh\ntouch '${shadow}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
  return { root, home, tree, shadowBin }
}

function fillCache(w: World, install: string, core: string, cli: string | null): void {
  const modules = path.join(w.home, '.construct/browser-lab/npm-cache/_npx', install, 'node_modules')
  holdPackage(modules, 'playwright-core', core, 'playwright-core', chromiumLibrary(path.join(w.root, CACHED_CORE_LOADED)), toolScript(path.join(w.root, CACHED_CORE_LOADED)))
  if (cli !== null)
    holdPackage(modules, '@playwright/cli', cli, 'playwright-cli', '', toolScript(path.join(w.root, CACHED_CLI_RAN)))
}

function runsLab(w: World, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: w.tree, encoding: 'utf8', env: { PATH: `${w.shadowBin}:${process.env.PATH ?? ''}`, HOME: w.home, TMPDIR: tmpdir() } })
}

function marked(w: World, marker: string): boolean {
  return existsSync(path.join(w.root, marker))
}

const HANDS = ['hands', '--profile', 'profile', '--', 'open', 'http://plain.invalid/']

describe('where browser-lab takes its tools from', () => {
  it('a package planted in the node_modules of the tree is not executed by browser-lab', () => {
    const w = world()
    fillCache(w, 'a', '1.62.1', '0.1.17')
    const page = runsLab(w, ['page', 'about:blank'])
    const hands = runsLab(w, HANDS)
    expect({ page: page.status, hands: hands.status }).toEqual({ page: 0, hands: 0 })
    expect({ shadow: marked(w, SHADOW_EXECUTED), core: marked(w, CACHED_CORE_LOADED), cli: marked(w, CACHED_CLI_RAN) }).toEqual({ shadow: false, core: true, cli: true })
  })

  it('browser-lab imports only built-in Node modules from the tree', () => {
    const specifiers = [...source.matchAll(/^import .* from '([^']+)'$/gm)].map(match => match[1]!)
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => !specifier.startsWith('node:'))).toEqual([])
    expect(source.match(/\bimport\(/g)).toHaveLength(1)
    expect(source).toMatch(/const binary = cachedBinary\(PLAYWRIGHT_CORE, 'playwright-core'\)\s+const library = await import\(/)
    expect(source).not.toMatch(/spawnSync\('npx'/)
  })

  it.each([['page', ['page', 'about:blank']], ['hands', HANDS]])('%s with no cached tool ends as unobserved and names why, with the shadow untouched', (_name, args) => {
    const w = world()
    const run = runsLab(w, args)
    expect(run.status).toBe(127)
    expect(run.stderr).toContain('is not in the lab cache')
    expect(marked(w, SHADOW_EXECUTED)).toBe(false)
  })

  it('a cached install of another version is not the pinned tool, even under the same name', () => {
    const w = world()
    fillCache(w, 'a', '1.62.0-alpha-1783623505000', '0.1.17')
    const run = runsLab(w, ['page', 'about:blank'])
    expect(run.status).toBe(127)
    expect(marked(w, CACHED_CORE_LOADED)).toBe(false)
  })

  it('finds the pinned tool in whichever cached install holds it', () => {
    const w = world()
    fillCache(w, 'a', '1.62.0-alpha-1783623505000', '0.1.17')
    fillCache(w, 'b', '1.62.1', null)
    const run = runsLab(w, ['page', 'about:blank'])
    expect(run.status).toBe(0)
    expect(marked(w, CACHED_CORE_LOADED)).toBe(true)
  })

  it('a cached binary that points out of the cache is not followed', () => {
    const w = world()
    const modules = path.join(w.home, '.construct/browser-lab/npm-cache/_npx/a/node_modules')
    mkdirSync(path.join(modules, '.bin'), { recursive: true })
    mkdirSync(path.join(modules, 'playwright-core'))
    writeFileSync(path.join(modules, 'playwright-core/package.json'), JSON.stringify({ version: '1.62.1' }))
    symlinkSync(path.join(w.tree, 'node_modules/playwright-core/tool.js'), path.join(modules, '.bin/playwright-core'))
    const run = runsLab(w, ['page', 'about:blank'])
    expect(run.status).toBe(127)
    expect(marked(w, SHADOW_EXECUTED)).toBe(false)
  })
})
