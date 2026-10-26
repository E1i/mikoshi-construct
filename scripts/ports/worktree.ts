import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { witnessEnv } from './session.js'
import { taskWorktree } from './worktree-home.js'

export interface ShellResult { status: number | null, output: string }
export type Shell = (command: string, cwd: string) => ShellResult

const SHELL_BUFFER = 1 << 28
const TAIL_LINES = 20
const INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']
const FETCH_MAIN_OVER_HTTPS = ['-c', 'url.https://github.com/.insteadOf=git@github.com:', '-c', 'url.https://github.com/.insteadOf=ssh://git@github.com/', 'fetch', 'origin', 'main']
const UNABLE_TO_CREATE = /unable to create file (.+?): /g

export function realShell(command: string, cwd: string): ShellResult {
  const result = spawnSync('bash', ['-c', command], { cwd, env: witnessEnv(), encoding: 'utf8', maxBuffer: SHELL_BUFFER })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: SHELL_BUFFER }).trim()
}

export function lastLine(output: string): string {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.at(-1) ?? 'no output'
}

export function tailLines(output: string, count = TAIL_LINES): string {
  return output.split('\n').filter(line => line.trim() !== '').slice(-count).join('\n')
}

export function withWorktree<T>(repo: string, base: string, run: (tree: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-preflight-'))
  const tree = path.join(dir, 'tree')
  gitIn(repo, ['worktree', 'add', '--detach', tree, base])
  try {
    return run(tree)
  }
  finally {
    try {
      gitIn(repo, ['worktree', 'remove', '--force', tree])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
      gitIn(repo, ['worktree', 'prune'])
    }
  }
}

export function stageSketch(tree: string, base: string, sketchSha: string): void {
  gitIn(tree, ['reset', '--hard', '-q', base])
  gitIn(tree, ['clean', '-fdq'])
  gitIn(tree, ['read-tree', '-m', '-u', base, sketchSha])
}

export function pnpmInstall(cwd: string, args: string[]): void {
  execFileSync('pnpm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export interface TreeDeps {
  cwd: string
  git: (cwd: string, args: string[]) => string
  install: (cwd: string, args: string[]) => void
  exists: (target: string) => boolean
  worktreeHome?: string
  treeOf?: (id: string) => string
}

export interface ReadyTree {
  worktree: string
  how: string
  failedAppend: string
}

export interface RefusedTree { refused: string }

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

function gitMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().split('\n').map(line => line.trim()).filter(line => line !== '').join(' / ')
}

function branchExists(deps: TreeDeps, repo: string, branch: string): boolean {
  try {
    deps.git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  }
  catch {
    return false
  }
}

function removeTree(deps: TreeDeps, repo: string, worktree: string, branch: string): string {
  try {
    deps.git(repo, ['worktree', 'remove', '--force', worktree])
    deps.git(repo, ['branch', '-D', branch])
    return `the tree and branch ${branch} were removed`
  }
  catch (error) {
    return `removing the tree failed (${firstLine(error)}); remove ${worktree} and branch ${branch} by hand`
  }
}

function unwritablePaths(message: string): string[] {
  return [...new Set([...message.matchAll(UNABLE_TO_CREATE)].map(match => match[1]!))]
}

function recoverCheckout(deps: TreeDeps, worktree: string, error: unknown): string[] | { failed: string } | null {
  const refused = unwritablePaths(error instanceof Error ? error.message : String(error))
  if (refused.length === 0 || !deps.exists(worktree))
    return null
  try {
    deps.git(worktree, ['read-tree', 'HEAD'])
    deps.git(worktree, ['checkout-index', '-a', '-f', '-u'])
  }
  catch (retry) {
    const stillRefused = unwritablePaths(retry instanceof Error ? retry.message : String(retry))
    if (stillRefused.length === 0)
      return { failed: gitMessage(retry) }
    refused.push(...stillRefused)
  }
  const absent = [...new Set(refused)]
  try {
    deps.git(worktree, ['update-index', '--skip-worktree', '--', ...absent])
  }
  catch (skip) {
    return { failed: gitMessage(skip) }
  }
  return absent
}

export function adoptTree(deps: TreeDeps, tree: string, branch: string): ReadyTree | RefusedTree {
  const worktree = path.resolve(deps.cwd, tree)
  let toplevel: string, commonDir: string, head: string, repoCommonDir: string
  try {
    [toplevel = '', commonDir = '', head = ''] = deps.git(worktree, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD']).trim().split('\n')
  }
  catch (error) {
    return { refused: `cannot adopt ${worktree}: it is not a git tree (${firstLine(error)}); nothing written` }
  }
  if (toplevel !== worktree)
    return { refused: `cannot adopt ${worktree}: it is not the top of a tree, ${toplevel} is; nothing written` }
  try {
    repoCommonDir = deps.git(deps.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  }
  catch (error) {
    return { refused: `not inside a git repository: ${firstLine(error)}` }
  }
  if (commonDir !== repoCommonDir)
    return { refused: `cannot adopt ${worktree}: it belongs to the repository at ${commonDir}, not to ${repoCommonDir}; nothing written` }
  if (head !== branch)
    return { refused: `cannot adopt ${worktree}: its HEAD is on ${head}, not on the card's branch ${branch}; nothing written` }
  return { worktree, how: `adopts ${worktree}`, failedAppend: `${worktree} was adopted on ${branch}` }
}

export function cutTree(deps: TreeDeps, id: string, branch: string): ReadyTree | RefusedTree {
  let repo: string
  try {
    repo = deps.git(deps.cwd, ['rev-parse', '--show-toplevel']).trim()
  }
  catch (error) {
    return { refused: `not inside a git repository: ${firstLine(error)}` }
  }
  const worktree = deps.treeOf?.(id) ?? taskWorktree(deps.worktreeHome ?? path.dirname(repo), id)
  if (deps.exists(worktree))
    return { refused: `${worktree} already exists; nothing written` }
  if (branchExists(deps, repo, branch))
    return { refused: `branch ${branch} already exists; nothing written` }
  let absent: string[] = []
  try {
    deps.git(repo, FETCH_MAIN_OVER_HTTPS)
  }
  catch (error) {
    return { refused: `could not cut ${worktree}: ${firstLine(error)}; nothing written` }
  }
  try {
    deps.git(repo, ['worktree', 'add', '-b', branch, worktree, 'origin/main'])
  }
  catch (error) {
    const recovered = recoverCheckout(deps, worktree, error)
    if (recovered === null)
      return { refused: `could not cut ${worktree}: ${gitMessage(error)}; nothing written` }
    if (!Array.isArray(recovered))
      return { refused: `could not cut ${worktree}: ${recovered.failed}; ${removeTree(deps, repo, worktree, branch)}; nothing written` }
    absent = recovered
  }
  try {
    deps.install(worktree, INSTALL_ARGS)
  }
  catch (error) {
    return { refused: `pnpm ${INSTALL_ARGS.join(' ')} failed in ${worktree}: ${firstLine(error)}; ${removeTree(deps, repo, worktree, branch)}; nothing written` }
  }
  const left = absent.length === 0 ? '' : `; absent from the tree, kept out of git status with skip-worktree because the sandbox refused the write: ${absent.join(', ')}`
  return { worktree, how: `cut ${worktree} from origin/main${left}`, failedAppend: `${worktree} was cut on ${branch}${left}` }
}
