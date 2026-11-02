import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export type TreePreparer = (tree: string) => void

export const PREPARE_TREE = ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts']

export const PREPARE_MS = 10 * 60_000

export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']

export const PREPARE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', ...PROXY_ENV_KEYS]

const LOCKFILE = 'pnpm-lock.yaml'

export function prepareEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(PREPARE_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]))
}

export function prepareTree(tree: string): void {
  execFileSync(PREPARE_TREE[0]!, PREPARE_TREE.slice(1), { cwd: tree, env: prepareEnv(process.env), timeout: PREPARE_MS, stdio: ['ignore', 'pipe', 'pipe'] })
}

function failureOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const said = Buffer.isBuffer(stderr) || typeof stderr === 'string' ? String(stderr).trim() : ''
  return said !== '' ? said : error instanceof Error ? error.message : String(error)
}

export function notPreparedLine(tree: string, why: string): string {
  return `the bus could not run ${PREPARE_TREE.join(' ')} in ${tree} before the session, so the session starts on the tree as it stands: ${why}`
}

export function prepareBeforeSession(tree: string, prepare: TreePreparer = prepareTree): string | null {
  if (!existsSync(path.join(tree, LOCKFILE)))
    return null
  try {
    prepare(tree)
    return null
  }
  catch (error) {
    return notPreparedLine(tree, failureOf(error))
  }
}
