import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { browserLabInstalledScript } from '../../src/commands/attach/settings.js'

export type TreePreparer = (tree: string) => void

export const PREPARE_TREE = ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts']

export const PREPARE_MS = 10 * 60_000

export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']

export const PREPARE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', ...PROXY_ENV_KEYS]

const LOCKFILE = 'pnpm-lock.yaml'
const BROWSER_LAB = 'scripts/construct/browser-lab.mjs'
const FACTORY_LAB = path.join(import.meta.dirname, '..', '..', BROWSER_LAB)
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'
const NODE_MODULES = 'node_modules'

const LAB_TOOLS = [
  { declared: /\bPLAYWRIGHT_CORE = '(playwright-core@\d+\.\d+\.\d+)'/, name: 'playwright-core', bin: 'playwright-core', install: 'playwright-core install chromium', readByBrowserWitnessThroughTree: true },
  { declared: /\bPLAYWRIGHT_CLI = '(@playwright\/cli@\d+\.\d+\.\d+)'/, name: '@playwright/cli', bin: 'playwright-cli', install: 'playwright-cli install-browser chromium', readByBrowserWitnessThroughTree: false },
] as const

type LabTool = typeof LAB_TOOLS[number]

export function prepareEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(PREPARE_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]))
}

const RESTORE_PACKAGES = '--force'

type InstallRunner = (tree: string, args: readonly string[]) => void

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

function directDependencies(tree: string): string[] {
  const manifest = path.join(tree, 'package.json')
  if (!existsSync(manifest))
    return []
  let declared: Partial<Record<typeof DEPENDENCY_FIELDS[number], Record<string, string>>>
  try {
    declared = JSON.parse(readFileSync(manifest, 'utf8')) as typeof declared
  }
  catch {
    return []
  }
  return [...new Set(DEPENDENCY_FIELDS.flatMap(field => Object.keys(declared[field] ?? {})))]
}

export function lacksItsPackages(tree: string): boolean {
  if (!existsSync(path.join(tree, LOCKFILE)))
    return false
  if (!existsSync(path.join(tree, NODE_MODULES)))
    return true
  return directDependencies(tree).some(name => !existsSync(path.join(tree, NODE_MODULES, name, 'package.json')))
}

function prepareArgs(tree: string): string[] {
  const plain = PREPARE_TREE.slice(1)
  return lacksItsPackages(tree) ? [...plain, RESTORE_PACKAGES] : plain
}

function runInstall(tree: string, args: readonly string[]): void {
  execFileSync(PREPARE_TREE[0]!, args, { cwd: tree, env: prepareEnv(process.env), timeout: PREPARE_MS, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function prepareTree(tree: string, run: InstallRunner = runInstall): void {
  run(tree, prepareArgs(tree))
}

function labHome(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME ?? os.homedir(), '.construct', 'browser-lab')
}

function installLabScript(factoryLab: string, env: NodeJS.ProcessEnv): void {
  const installed = browserLabInstalledScript(env.HOME ?? os.homedir())
  const temporary = `${installed}.${process.pid}.tmp`
  mkdirSync(path.dirname(installed), { recursive: true })
  try {
    copyFileSync(factoryLab, temporary)
    renameSync(temporary, installed)
  }
  catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function installedBinary(cache: string, spec: string, tool: LabTool, env: NodeJS.ProcessEnv): string {
  const said = execFileSync('npx', ['--yes', '--package', spec, '-c', `${tool.install} && command -v ${tool.bin}`], { cwd: cache, env, encoding: 'utf8', timeout: PREPARE_MS, stdio: ['ignore', 'pipe', 'pipe'] })
  return realpathSync(said.trim().split('\n').at(-1)!)
}

function packageRoot(binary: string, tool: LabTool): string {
  const inPackage = `${path.join(NODE_MODULES, tool.name)}${path.sep}`
  const at = binary.lastIndexOf(inPackage)
  if (at === -1)
    throw new Error(`${binary} is not inside a ${tool.name} package`)
  return binary.slice(0, at + inPackage.length - 1)
}

function linkUnlessTheRepositorysOwn(link: string, target: string, cache: string): void {
  const held = lstatSync(link, { throwIfNoEntry: false })
  if (held !== undefined) {
    if (!held.isSymbolicLink() || !readlinkSync(link).startsWith(cache))
      return
    rmSync(link)
  }
  mkdirSync(path.dirname(link), { recursive: true })
  symlinkSync(target, link)
}

export function preinstallBrowser(tree: string, env: NodeJS.ProcessEnv = process.env, factoryLab: string = FACTORY_LAB): void {
  if (!existsSync(path.join(tree, BROWSER_LAB)))
    return
  const prepared = prepareEnv(env)
  execFileSync('git', ['-C', tree, 'check-ignore', '-q', `${NODE_MODULES}/`], { env: prepared, stdio: ['ignore', 'pipe', 'pipe'] })
  const text = readFileSync(factoryLab, 'utf8')
  const npxEnv = { ...prepared, npm_config_registry: PUBLIC_REGISTRY, npm_config_cache: path.join(labHome(env), 'npm-cache'), npm_config_ignore_scripts: 'true' }
  for (const tool of LAB_TOOLS) {
    const spec = tool.declared.exec(text)?.[1]
    if (spec === undefined)
      continue
    mkdirSync(npxEnv.npm_config_cache, { recursive: true })
    const cache = realpathSync(npxEnv.npm_config_cache)
    const binary = installedBinary(cache, spec, tool, npxEnv)
    if (!tool.readByBrowserWitnessThroughTree)
      continue
    linkUnlessTheRepositorysOwn(path.join(tree, NODE_MODULES, tool.name), packageRoot(binary, tool), cache)
    linkUnlessTheRepositorysOwn(path.join(tree, NODE_MODULES, '.bin', tool.bin), binary, cache)
  }
  installLabScript(factoryLab, env)
}

function failureOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const said = Buffer.isBuffer(stderr) || typeof stderr === 'string' ? String(stderr).trim() : ''
  return said !== '' ? said : error instanceof Error ? error.message : String(error)
}

export function notPreparedLine(tree: string, why: string): string {
  return `the bus could not run ${PREPARE_TREE.join(' ')} in ${tree} before the session, so the session starts on the tree as it stands: ${why}`
}

export function browserNotPreinstalledLine(tree: string, why: string): string {
  return `the bus could not preinstall the browser lab in ${tree} before the session, so a browser-lab run in that session ends as unobserved when a tool is missing from the lab cache: ${why}`
}

function failureLine(step: TreePreparer, tree: string, lineOf: (tree: string, why: string) => string): string | null {
  try {
    step(tree)
    return null
  }
  catch (error) {
    return lineOf(tree, failureOf(error))
  }
}

export function prepareBeforeSession(tree: string, prepare: TreePreparer = prepareTree, preinstall: TreePreparer = preinstallBrowser): string | null {
  const unprepared = existsSync(path.join(tree, LOCKFILE)) ? failureLine(prepare, tree, notPreparedLine) : null
  const noBrowser = failureLine(preinstall, tree, browserNotPreinstalledLine)
  return unprepared === null || noBrowser === null ? unprepared ?? noBrowser : `${unprepared}\n${noBrowser}`
}
