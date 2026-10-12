import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const RUN_ROOT_VARIABLE = 'CONSTRUCT_RUN_ROOT'
export const RUN_ROOT_PREFIX = 'mkr-'
export const UNIX_SOCKET_PATH_BYTES = 103
export const SOCKET_NAME_RESERVE_BYTES = 24
const MKDTEMP_SUFFIX = 'XXXXXX'
const OWNER_PID = new RegExp(`^${RUN_ROOT_PREFIX}(\\d+)-[A-Za-z0-9]{${MKDTEMP_SUFFIX.length}}$`)
const VITEST_TMP_DIR_NAME = /^[\w-]{21}$/
const VITEST_ENVIRONMENT_DIRS: ReadonlySet<string> = new Set(['ssr', 'client'])
export const VITEST_LEFTOVER_AGE_MS = 6 * 60 * 60 * 1000
const RELEASING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export interface RunRootOptions {
  outer?: string
  pid?: number
  env?: NodeJS.ProcessEnv
  isAlive?: (pid: number) => boolean
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class RunRootTooLong extends Error {
  constructor(readonly root: string, readonly bytes: number) {
    super(`[run-root] ${root} takes ${bytes} bytes; with ${SOCKET_NAME_RESERVE_BYTES} more for a socket name it passes the ${UNIX_SOCKET_PATH_BYTES}-byte Unix socket path limit, so a tool opening a socket under it would fail with listen EINVAL. Point TMPDIR at a shorter directory.`)
  }
}

export function refuseRootTooLongForASocket(root: string): void {
  const bytes = Buffer.byteLength(root)
  if (bytes + SOCKET_NAME_RESERVE_BYTES > UNIX_SOCKET_PATH_BYTES)
    throw new RunRootTooLong(root, bytes)
}

export function reapOrphanRoots(outer: string, alive: (pid: number) => boolean = isAlive): string[] {
  const orphans = readdirSync(outer).filter((name) => {
    const owner = OWNER_PID.exec(name)?.[1]
    return owner !== undefined && !alive(Number(owner))
  })
  for (const name of orphans)
    rmSync(path.join(outer, name), { recursive: true, force: true })
  return orphans
}

function lastWrittenMs(dir: string, children: string[]): number {
  return Math.max(statSync(dir).mtimeMs, ...children.map(child => statSync(path.join(dir, child)).mtimeMs))
}

function isVitestLeftover(dir: string, nowMs: number): boolean {
  try {
    return isStaleVitestDir(dir, nowMs)
  }
  catch {
    return false
  }
}

function isStaleVitestDir(dir: string, nowMs: number): boolean {
  if (!VITEST_TMP_DIR_NAME.test(path.basename(dir)) || !statSync(dir).isDirectory())
    return false
  const children = readdirSync(dir)
  return children.length > 0
    && children.every(child => VITEST_ENVIRONMENT_DIRS.has(child))
    && nowMs - lastWrittenMs(dir, children) > VITEST_LEFTOVER_AGE_MS
}

export function reapVitestLeftovers(outer: string, nowMs: number = Date.now()): string[] {
  const leftovers = readdirSync(outer).filter(name => isVitestLeftover(path.join(outer, name), nowMs))
  for (const name of leftovers)
    rmSync(path.join(outer, name), { recursive: true, force: true })
  return leftovers
}

export class RunRoot {
  private readonly previous: { root: string | undefined, tmpdir: string | undefined }

  private constructor(readonly path: string, private readonly env: NodeJS.ProcessEnv) {
    this.previous = { root: env[RUN_ROOT_VARIABLE], tmpdir: env.TMPDIR }
    env[RUN_ROOT_VARIABLE] = this.path
    env.TMPDIR = this.path
  }

  static open(options: RunRootOptions = {}): RunRoot {
    const outer = options.outer ?? os.tmpdir()
    const template = path.join(outer, `${RUN_ROOT_PREFIX}${options.pid ?? process.pid}-`)
    refuseRootTooLongForASocket(`${template}${MKDTEMP_SUFFIX}`)
    reapOrphanRoots(outer, options.isAlive)
    reapVitestLeftovers(outer)
    const root = mkdtempSync(template)
    return new RunRoot(root, options.env ?? process.env)
  }

  close(): boolean {
    restore(this.env, RUN_ROOT_VARIABLE, this.previous.root)
    restore(this.env, 'TMPDIR', this.previous.tmpdir)
    rmSync(this.path, { recursive: true, force: true })
    return !this.exists()
  }

  exists(): boolean {
    return existsSync(this.path)
  }
}

function restore(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (value === undefined)
    delete env[name]
  else
    env[name] = value
}

let ownRoot: RunRoot | undefined

function closeOwnRootOnExit(root: RunRoot): void {
  process.once('exit', () => root.close())
  for (const signal of RELEASING_SIGNALS) {
    process.once(signal, () => {
      root.close()
      process.kill(process.pid, signal)
    })
  }
}

export function inheritedRunRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const inherited = env[RUN_ROOT_VARIABLE]
  return inherited !== undefined && existsSync(inherited) ? inherited : undefined
}

export function currentRunRoot(env: NodeJS.ProcessEnv = process.env): string {
  const inherited = inheritedRunRoot(env)
  if (inherited !== undefined)
    return inherited
  if (ownRoot === undefined) {
    ownRoot = RunRoot.open({ env })
    closeOwnRootOnExit(ownRoot)
  }
  return ownRoot.path
}

export function scratchDir(prefix: string): string {
  return mkdtempSync(path.join(currentRunRoot(), prefix))
}
