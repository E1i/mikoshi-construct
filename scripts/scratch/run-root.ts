import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const RUN_ROOT_VARIABLE = 'CONSTRUCT_RUN_ROOT'
export const RUN_ROOT_PREFIX = 'mkr-'
export const UNIX_SOCKET_PATH_BYTES = 103
export const SOCKET_NAME_RESERVE_BYTES = 24
const MKDTEMP_SUFFIX = 'XXXXXX'
const OWNER_PID = new RegExp(`^${RUN_ROOT_PREFIX}(\\d+)-[A-Za-z0-9]{${MKDTEMP_SUFFIX.length}}$`)
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

export function currentRunRoot(env: NodeJS.ProcessEnv = process.env): string {
  const inherited = env[RUN_ROOT_VARIABLE]
  if (inherited !== undefined && existsSync(inherited))
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
