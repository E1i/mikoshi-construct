import type { SpawnSyncReturns } from 'node:child_process'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { preinstallBrowser, prepareBeforeSession } from '../../ports/prepare-tree.js'

const LAB = 'scripts/construct/browser-lab.mjs'
const DEAD_PROXY = 'http://127.0.0.1:9'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const STUB_CHROMIUM = `
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const marker = path.join(os.homedir(), 'chromium-installed')
const page = { on() {}, goto: async () => ({ status: () => 200 }), title: async () => 'stub', evaluate: async () => '', screenshot: async () => {}, url: () => 'about:blank' }
const session = { on() {}, send: async () => ({}), detach: async () => {} }
const context = { newPage: async () => page, pages: () => [page], newCDPSession: async () => session, close: async () => {}, on() {}, route: async () => {}, serviceWorkers: () => [] }
export const chromium = {
  executablePath: () => marker,
  launchPersistentContext: async () => {
    if (!existsSync(marker))
      throw new Error('Executable doesn\\'t exist')
    return context
  },
}
`

const STUB_INSTALL = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
writeFileSync(join(homedir(), 'chromium-installed'), '')
`

interface Fixture {
  home: string
  tree: string
  bin: string
  log: string
  env: NodeJS.ProcessEnv
}

function stubPackage(root: string, name: string, version: string, binName: string, binFile: string): void {
  const dir = path.join(root, 'packages', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, type: 'commonjs', bin: { [binName]: binFile } }))
  writeFileSync(path.join(dir, binFile), STUB_INSTALL)
  chmodSync(path.join(dir, binFile), 0o755)
  writeFileSync(path.join(dir, 'index.mjs'), STUB_CHROMIUM)
}

function fillingNpx(root: string, log: string): string {
  return `#!/bin/bash
echo "$*" >> '${log}'
spec="$3"
case "$spec" in
  playwright-core@*) name=playwright-core; file=cli.js; bin=playwright-core ;;
  *) name=@playwright/cli; file=playwright-cli.js; bin=playwright-cli ;;
esac
dir="$npm_config_cache/_npx/$bin/node_modules"
mkdir -p "$dir/.bin" "$(dirname "$dir/$name")"
rm -rf "$dir/$name"
cp -R '${root}/packages/'"$name" "$dir/$name"
ln -sf "../$name/$file" "$dir/.bin/$bin"
PATH="$dir/.bin:$PATH" bash -c "$5"
`
}

function fixture(lab: string = readFileSync(path.join(process.cwd(), LAB), 'utf8')): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'browser-preinstall-')))
  roots.push(root)
  const home = path.join(root, 'home')
  const tree = path.join(root, 'tree')
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'npx.log')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(path.join(tree, path.dirname(LAB)), { recursive: true })
  execFileSync('git', ['init', '-q', tree])
  writeFileSync(path.join(tree, '.gitignore'), 'node_modules\n')
  writeFileSync(path.join(tree, LAB), lab)
  stubPackage(root, 'playwright-core', '1.62.1', 'playwright-core', 'cli.js')
  stubPackage(root, '@playwright/cli', '0.1.17', 'playwright-cli', 'playwright-cli.js')
  writeFileSync(path.join(bin, 'npx'), fillingNpx(root, log))
  chmodSync(path.join(bin, 'npx'), 0o755)
  return { home, tree, bin, log, env: { PATH: `${bin}:${process.env.PATH}`, HOME: home } }
}

function sessionRunsLab(f: Fixture): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [LAB, 'page', 'about:blank'], {
    cwd: f.tree,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: f.home, TMPDIR: tmpdir(), HTTPS_PROXY: DEAD_PROXY, HTTP_PROXY: DEAD_PROXY, https_proxy: DEAD_PROXY, http_proxy: DEAD_PROXY, npm_config_fetch_retries: '0', npm_config_update_notifier: 'false', SANDBOX_RUNTIME: '1' },
  })
}

function npxCalls(f: Fixture): string[] {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n') : []
}

describe('the browser preinstall', () => {
  it('a sandboxed session runs browser-lab page about:blank with no registry', () => {
    const f = fixture()
    preinstallBrowser(f.tree, f.env)
    const run = sessionRunsLab(f)
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout).url).toBe('about:blank')
  })

  it('the same session with no preinstall cannot get the lab from a registry it cannot reach', () => {
    const f = fixture()
    const run = sessionRunsLab(f)
    expect(run.status).toBe(127)
    expect(run.stderr).toContain('npx could not provide')
  })

  it('fills both lab tools through the public registry into the cache the lab reads', () => {
    const f = fixture()
    preinstallBrowser(f.tree, f.env)
    expect(npxCalls(f).map(call => call.split(' ')[2])).toEqual(['playwright-core@1.62.1', '@playwright/cli@0.1.17'])
    expect(existsSync(path.join(f.home, '.construct/browser-lab/npm-cache/_npx/playwright-core/node_modules/playwright-core/index.mjs'))).toBe(true)
    expect(existsSync(path.join(f.home, 'chromium-installed'))).toBe(true)
  })

  it('leaves the tree clean, since what it links is ignored', () => {
    const f = fixture()
    execFileSync('git', ['-C', f.tree, 'add', '.'])
    preinstallBrowser(f.tree, f.env)
    expect(execFileSync('git', ['-C', f.tree, 'diff', '--cached', '--name-only', '--diff-filter=D'], { encoding: 'utf8' })).toBe('')
    expect(execFileSync('git', ['-C', f.tree, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' })).not.toContain('node_modules')
  })

  it('does nothing in a tree with no lab', () => {
    const f = fixture()
    rmSync(path.join(f.tree, LAB))
    preinstallBrowser(f.tree, f.env)
    expect(npxCalls(f)).toEqual([])
  })

  it('never hands npx a spec from the tree that is not one exact version', () => {
    const f = fixture(`export const PLAYWRIGHT_CORE = 'playwright-core@latest'\nexport const PLAYWRIGHT_CLI = '@playwright/cli@0.1.17 && touch owned'\n`)
    preinstallBrowser(f.tree, f.env)
    expect(npxCalls(f)).toEqual([])
  })

  it('leaves alone an entry the repository installed itself', () => {
    const f = fixture()
    const own = path.join(f.tree, 'node_modules/playwright-core')
    mkdirSync(own, { recursive: true })
    writeFileSync(path.join(own, 'mine'), '')
    preinstallBrowser(f.tree, f.env)
    expect(lstatSync(own).isDirectory()).toBe(true)
    expect(existsSync(path.join(own, 'mine'))).toBe(true)
  })

  it('refuses to link into a tree that does not ignore node_modules', () => {
    const f = fixture()
    rmSync(path.join(f.tree, '.gitignore'))
    expect(() => preinstallBrowser(f.tree, f.env)).toThrow()
    expect(existsSync(path.join(f.tree, 'node_modules'))).toBe(false)
  })

  it('a preinstall that fails gives a line and the session still starts', () => {
    const f = fixture()
    const line = prepareBeforeSession(f.tree, () => {}, () => {
      throw new Error('no registry here')
    })
    expect(line).toContain('could not preinstall the browser lab')
    expect(line).toContain('no registry here')
  })

  it('preinstalls in a tree with a lab and no lockfile, and installs only where the lockfile is', () => {
    const f = fixture()
    const steps: string[] = []
    prepareBeforeSession(f.tree, () => steps.push('install'), () => steps.push('browser'))
    expect(steps).toEqual(['browser'])
    copyFileSync(path.join(f.tree, '.gitignore'), path.join(f.tree, 'pnpm-lock.yaml'))
    prepareBeforeSession(f.tree, () => steps.push('install'), () => steps.push('browser'))
    expect(steps).toEqual(['browser', 'install', 'browser'])
  })
})
