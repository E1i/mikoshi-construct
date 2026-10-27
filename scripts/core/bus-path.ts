import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { FACTORY_NAMED } from './factory-paths.js'

export const OWNER_AGENT = 'dev.mikoshi.bus'
export const OWNER_AGENT_FILE = path.join(FACTORY_NAMED.launchdDirectory, `${OWNER_AGENT}.plist`)
export const BUS_DB_VARIABLE = 'CONSTRUCT_BUS_DB'
export const CONSTRUCT_HOME_DIR = '.construct'
export const BUS_FILE = 'bus.db'
export const BUS_DIR = 'bus'
export const DECISIONS_FILE = 'owner-decisions.md'
export const PREFERRED_REMOTE = 'origin'
export const REPO_ID_SEPARATOR = '--'
export const LOCAL_REPO_PREFIX = 'local'

const GIT_ENTRY = '.git'
const GITDIR_POINTER = /^gitdir:(.+)$/m
const REMOTE_SECTION = /^\s*\[remote\s+"([^"]+)"\]\s*$/
const ANY_SECTION = /^\s*\[/
const URL_LINE = /^\s*url\s*=(.+)$/
const SLUG_TAIL = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/
const UNSAFE_ID_CHARACTER = /[^\w.-]/g
const LOCAL_HASH_LENGTH = 12

function readIfFile(file: string): string | null {
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null
}

export function repositoryRoot(dir: string): string | null {
  let current = path.resolve(dir)
  for (;;) {
    if (existsSync(path.join(current, GIT_ENTRY)))
      return current
    const parent = path.dirname(current)
    if (parent === current)
      return null
    current = parent
  }
}

function gitDirOf(root: string): string {
  const entry = path.join(root, GIT_ENTRY)
  const pointer = readIfFile(entry)?.match(GITDIR_POINTER)?.[1]?.trim()
  return pointer === undefined ? entry : path.resolve(root, pointer)
}

function commonDirOf(gitDir: string): string {
  const common = readIfFile(path.join(gitDir, 'commondir'))?.trim()
  return common === undefined || common === '' ? gitDir : path.resolve(gitDir, common)
}

export function remoteUrls(config: string): Map<string, string> {
  const urls = new Map<string, string>()
  let remote: string | null = null
  for (const line of config.split('\n')) {
    const section = line.match(REMOTE_SECTION)
    if (section !== null) {
      remote = section[1]!
      continue
    }
    if (ANY_SECTION.test(line)) {
      remote = null
      continue
    }
    const url = line.match(URL_LINE)?.[1]?.trim()
    if (remote !== null && url !== undefined && !urls.has(remote))
      urls.set(remote, url)
  }
  return urls
}

export function remoteUrlOf(dir: string): string | null {
  const root = repositoryRoot(dir)
  if (root === null)
    return null
  const config = readIfFile(path.join(commonDirOf(gitDirOf(root)), 'config'))
  if (config === null)
    return null
  const urls = remoteUrls(config)
  return urls.get(PREFERRED_REMOTE) ?? urls.values().next().value ?? null
}

export function repoSlugOfUrl(url: string): string | null {
  const match = url.match(SLUG_TAIL)
  return match === null ? null : `${match[1]}/${match[2]}`
}

export function repoSlugOf(dir: string): string | null {
  const url = remoteUrlOf(dir)
  return url === null ? null : repoSlugOfUrl(url)
}

function safeSegment(text: string): string {
  return text.replace(UNSAFE_ID_CHARACTER, '_')
}

export function repoIdOf(dir: string): string {
  const slug = repoSlugOf(dir)
  if (slug !== null)
    return slug.split('/').map(safeSegment).join(REPO_ID_SEPARATOR)
  const place = repositoryRoot(dir) ?? path.resolve(dir)
  const hash = createHash('sha256').update(place).digest('hex').slice(0, LOCAL_HASH_LENGTH)
  return [LOCAL_REPO_PREFIX, `${safeSegment(path.basename(place))}-${hash}`].join(REPO_ID_SEPARATOR)
}

export function constructHome(home: string): string {
  return path.join(home, CONSTRUCT_HOME_DIR)
}

export function repoHome(home: string, repoId: string): string {
  return path.join(constructHome(home), repoId)
}

export function machineBusPath(home: string): string {
  return path.join(constructHome(home), BUS_FILE)
}

export class ForeignBusRefused extends Error {
  constructor(readonly named: string, readonly own: string, readonly machine: string) {
    super(`Refused: ${BUS_DB_VARIABLE} names ${named}, the bus of another repository; this repository's bus is ${own}, or the machine bus ${machine}. Nothing was written.`)
  }
}

function insideDir(dir: string, file: string): boolean {
  const relative = path.relative(dir, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function checkedNamedBus(named: string, home: string, dir: string): string {
  if (repositoryRoot(dir) === null)
    return named
  const own = path.join(repoHome(home, repoIdOf(dir)), BUS_FILE)
  const machine = machineBusPath(home)
  const resolved = path.resolve(named)
  if (insideDir(constructHome(home), resolved) && resolved !== own && resolved !== machine)
    throw new ForeignBusRefused(named, own, machine)
  return named
}

export function busPathOf(env: NodeJS.ProcessEnv, home: string, dir: string, machineFallback = true): string {
  const named = env[BUS_DB_VARIABLE]
  if (named !== undefined && named !== '')
    return checkedNamedBus(named, home, dir)
  const own = path.join(repoHome(home, repoIdOf(dir)), BUS_FILE)
  const machine = machineBusPath(home)
  return machineFallback && !existsSync(own) && existsSync(machine) ? machine : own
}

export function pinBus(env: NodeJS.ProcessEnv, home: string, dir: string, machineFallback = true): string {
  const busPath = busPathOf(env, home, dir, machineFallback)
  env[BUS_DB_VARIABLE] = busPath
  return busPath
}

export function busDirOf(busPath: string): string {
  return path.join(path.dirname(busPath), BUS_DIR)
}

export function decisionsFileOf(busPath: string): string {
  return path.join(path.dirname(busPath), DECISIONS_FILE)
}

export function isMachineBus(home: string, busPath: string): boolean {
  return path.resolve(busPath) === machineBusPath(home)
}

export function isOwnerCheckout(dir: string): boolean {
  return existsSync(path.join(repositoryRoot(dir) ?? dir, OWNER_AGENT_FILE))
}

export function defaultBusPath(): string {
  const dir = process.cwd()
  return busPathOf(process.env, os.homedir(), dir, isOwnerCheckout(dir))
}

export function defaultBusDir(): string {
  return busDirOf(defaultBusPath())
}

export function busExpected(): boolean {
  return existsSync(defaultBusPath())
}
