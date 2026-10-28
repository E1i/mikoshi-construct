import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/browser-lab.mjs')
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'

interface Options {
  command: string
  positionals: string[]
  route: { pattern: string, file: string }[]
  prefix: string | undefined
  shot: string | undefined
  profile: string | undefined
  profileFrom: string | undefined
}

interface HandsConfig {
  browser: { userDataDir: string, launchOptions: { args: string[], headless: boolean } }
}

interface BrowserLab {
  parseArguments: (argv: string[]) => Options
  handsRefusal: (ran: { status: number | null, stdout?: string, stderr?: string, error?: Error }) => string
  handsConfig: (extensionDirectory: string, profile: string, headed: boolean) => HandsConfig
  npxEnvironment: (base?: Record<string, string>) => Record<string, string>
  PLAYWRIGHT_CORE: string
  PLAYWRIGHT_CLI: string
  UsageError: new () => Error
}

const { parseArguments, handsRefusal, handsConfig, npxEnvironment, PLAYWRIGHT_CORE, PLAYWRIGHT_CLI, UsageError } = await import(pathToFileURL(SCRIPT).href) as BrowserLab
const source = readFileSync(SCRIPT, 'utf8')

describe('the page arguments of the lab', () => {
  it('takes --prefix and --shot', () => {
    expect(parseArguments(['page', 'http://x', '--prefix', '[ext]', '--shot', 'out.png'])).toMatchObject({ prefix: '[ext]', shot: 'out.png' })
  })

  it('takes --route twice, each with a glob and a file', () => {
    expect(parseArguments(['page', 'http://x', '--route', '**/a.js', 'a.js', '--route', '**/b.css', 'b.css']).route).toEqual([
      { pattern: '**/a.js', file: 'a.js' },
      { pattern: '**/b.css', file: 'b.css' },
    ])
  })

  it.each([
    [['page', 'http://x', '--route', '**/a.js']],
    [['page', 'http://x', '--route', '**/a.js', '--shot']],
    [['page', 'http://x', '--prefix']],
    [['info', '--extension', 'ext', '--shot', 'out.png']],
    [['info', '--extension', 'ext', '--prefix', 'x']],
  ])('refuses %j', (argv) => {
    expect(() => parseArguments(argv)).toThrow(UsageError)
  })

  it('takes --profile-from and refuses it together with --profile', () => {
    expect(parseArguments(['page', 'http://x', '--profile-from', 'base']).profileFrom).toBe('base')
    expect(() => parseArguments(['page', 'http://x', '--profile-from', 'base', '--profile', 'kept'])).toThrow(UsageError)
  })
})

describe('hands', () => {
  it('takes everything after -- as the arguments of the playwright cli', () => {
    expect(parseArguments(['hands', '--extension', 'ext', '--profile', 'dir', '--', 'snapshot', '--depth=2'])).toMatchObject({ command: 'hands', positionals: ['snapshot', '--depth=2'], profile: 'dir' })
  })

  it.each([
    [['hands', '--extension', 'ext', '--profile', 'dir']],
    [['hands', '--profile', 'dir', '--', 'open']],
    [['hands', '--extension', 'ext', '--', 'open']],
  ])('refuses %j', (argv) => {
    expect(() => parseArguments(argv)).toThrow(UsageError)
  })

  it('the generated config loads the lab copy of the extension and the profile directory', () => {
    const config = handsConfig('/profile/extension', '/profile', false)
    expect(config.browser.userDataDir).toBe('/profile')
    expect(config.browser.launchOptions.args).toContain('--load-extension=/profile/extension')
    expect(config.browser.launchOptions.args).toContain('--disable-extensions-except=/profile/extension')
    expect(config.browser.launchOptions.headless).toBe(true)
  })
})

describe('a refused hands run', () => {
  it('names the exit code and the last five lines of stdout and stderr', () => {
    const stdout = 'The browser \'default\' is not open, please run open first\n\n  playwright-cli open [params]'
    const stderr = ['1', '2', '3', '4', '5', '6'].join('\n')
    const message = handsRefusal({ status: 1, stdout, stderr })
    expect(message).toContain('exit 1')
    expect(message).toContain('The browser \'default\' is not open, please run open first |  | ')
    expect(message).toContain('stderr: 2 | 3 | 4 | 5 | 6')
    expect(message).not.toContain('1 | 2')
  })

  it('names a spawn error', () => {
    expect(handsRefusal({ status: null, error: new Error('spawn ENOENT') })).toBe('hands failed: spawn ENOENT')
  })
})

describe('the npx registry', () => {
  it('every npx environment names the public registry whatever the environment says', () => {
    expect(npxEnvironment({ npm_config_registry: 'https://private.example/' }).npm_config_registry).toBe(PUBLIC_REGISTRY)
  })

  it('the script spawns npx in one place, with that environment', () => {
    expect(source.match(/spawnSync\('npx'/g)).toHaveLength(1)
    expect(source).toMatch(/function runNpx\(args, options\) \{\s+return spawnSync\('npx', args, \{ \.\.\.options, env: npxEnvironment\(\) \}\)/)
  })
})

describe('the npx cache and the pinned builds', () => {
  it('every npx environment carries an npm_config_cache under ~/.construct, set inside the script', () => {
    const cache = npxEnvironment({ npm_config_cache: '/root-owned/.npm' }).npm_config_cache
    expect(cache).toBeDefined()
    expect(path.relative(path.join(os.homedir(), '.construct'), cache as string).startsWith('..')).toBe(false)
  })

  it('hands pin @playwright/cli@0.1.17 and the lab playwright-core@1.62.1', () => {
    expect(PLAYWRIGHT_CLI).toBe('@playwright/cli@0.1.17')
    expect(PLAYWRIGHT_CORE).toBe('playwright-core@1.62.1')
  })
})
