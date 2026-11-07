import type { ProcessCwds } from './client/contract.js'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { witnessEnv } from './session.js'
import { taskWorktree } from './worktree-home.js'

const execFileAsync = promisify(execFile)

export interface ShellResult { status: number | null, output: string }
export type Shell = (command: string, cwd: string) => ShellResult

const SHELL_BUFFER = 1 << 28
const TAIL_LINES = 20
const FROZEN_INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline']
const LOCKLESS_INSTALL_ARGS = ['install', '--prefer-offline']
const LOCKFILE = 'pnpm-lock.yaml'
const FETCH_MAIN_OVER_HTTPS = ['-c', 'url.https://github.com/.insteadOf=git@github.com:', '-c', 'url.https://github.com/.insteadOf=ssh://git@github.com/', 'fetch', 'origin', 'main']
const UNABLE_TO_CREATE = /unable to create file (.+?): /g
const ADD_FOUND_ANOTHER_CUT = /already exists/
export const FREE_TREES = '.free'
const CLEAN_ALL_BUT_INSTALLED = ['clean', '-fdxq', '-e', 'node_modules']
const LINK_FROM_THE_SHARED_STORE = '--config.packageImportMethod=hardlink'
const NEVER_INDEX_MARKER = '.metadata_never_index'

export const FREE_TREE_CAPACITY = 8

const LSOF_PATH_FIELD = 'n'
const LSOF_FOUND_NONE = 1
export const LSOF_CLIENT_NAMES = ['-c', 'claude', '-c', '/^[0-9]+[.][0-9]+[.][0-9]+$/']

export type GitRun = (cwd: string, args: string[]) => string

export function realShell(command: string, cwd: string): ShellResult {
  const result = spawnSync('bash', ['-c', command], { cwd, env: witnessEnv(), encoding: 'utf8', maxBuffer: SHELL_BUFFER })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: SHELL_BUFFER }).trim()
}

export type GitAsync = (cwd: string, args: string[]) => Promise<string>

export const gitInAsync: GitAsync = async (cwd, args) => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: SHELL_BUFFER })
  return stdout.trim()
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

export class SetupTurns {
  private last: Promise<void> = Promise.resolve()

  async take<T>(step: () => Promise<T>): Promise<T> {
    const previous = this.last
    let finish = (): void => {}
    this.last = new Promise((resolve) => {
      finish = resolve
    })
    await previous
    try {
      return await step()
    }
    finally {
      finish()
    }
  }
}

export async function withWorktreeAsync<T>(repo: string, base: string, run: (tree: string) => Promise<T>, turns: SetupTurns, git: GitAsync = gitInAsync): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-preflight-'))
  const tree = path.join(dir, 'tree')
  await turns.take(() => git(repo, ['worktree', 'add', '--detach', tree, base]))
  try {
    return await run(tree)
  }
  finally {
    await turns.take(async () => {
      try {
        await git(repo, ['worktree', 'remove', '--force', tree])
      }
      finally {
        rmSync(dir, { recursive: true, force: true })
        await git(repo, ['worktree', 'prune'])
      }
    })
  }
}

export function stageSketch(tree: string, base: string, sketchSha: string): void {
  gitIn(tree, ['reset', '--hard', '-q', base])
  gitIn(tree, ['clean', '-fdq'])
  gitIn(tree, ['read-tree', '-m', '-u', base, sketchSha])
}

export function pnpmInstall(cwd: string, args: string[]): void {
  execFileSync('pnpm', [...args, LINK_FROM_THE_SHARED_STORE], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function freeTreeHome(tree: string): string {
  return path.join(path.dirname(tree), FREE_TREES)
}

function realOrAsWritten(where: string): string {
  return existsSync(where) ? realpathSync(where) : where
}

function cwdsInLsofOutput(output: string): string[] {
  return output.split('\n').filter(line => line.startsWith(LSOF_PATH_FIELD)).map(line => line.slice(LSOF_PATH_FIELD.length))
}

export function claudeProcessCwds(): ProcessCwds {
  try {
    return { kind: 'listed', cwds: cwdsInLsofOutput(execFileSync('lsof', ['-a', ...LSOF_CLIENT_NAMES, '-d', 'cwd', '-F', LSOF_PATH_FIELD], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
  }
  catch (error) {
    const failed = error as { status?: unknown, stdout?: unknown }
    if (failed.status === LSOF_FOUND_NONE)
      return { kind: 'listed', cwds: cwdsInLsofOutput(typeof failed.stdout === 'string' ? failed.stdout : '') }
    return { kind: 'unreadable', why: error instanceof Error ? error.message.trim() : String(error) }
  }
}

export function liveSessionHolds(tree: string, cwds: () => ProcessCwds = claudeProcessCwds): boolean {
  const read = cwds()
  if (read.kind === 'unreadable')
    return true
  const real = realOrAsWritten(tree)
  return read.cwds.some(cwd => cwd === real || cwd.startsWith(`${real}${path.sep}`))
}

function freeTreesIn(git: GitRun, repo: string, home: string): string[] {
  const inside = realOrAsWritten(home)
  return git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .filter(tree => existsSync(tree) && path.dirname(realpathSync(tree)) === inside)
}

export function parkTree(git: GitRun, repo: string, tree: string, capacity: number): string | null {
  const home = freeTreeHome(tree)
  if (freeTreesIn(git, repo, home).length >= capacity)
    return null
  mkdirSync(home, { recursive: true })
  const parked = path.join(home, path.basename(tree))
  git(tree, ['reset', '--hard', '-q'])
  git(tree, ['checkout', '-q', '--detach'])
  git(tree, CLEAN_ALL_BUT_INSTALLED)
  git(repo, ['worktree', 'move', tree, parked])
  return parked
}

function settled(git: GitRun, tree: string, settle: (tree: string) => void): boolean {
  try {
    settle(tree)
    git(tree, CLEAN_ALL_BUT_INSTALLED)
    return git(tree, ['status', '--porcelain']).trim() === ''
  }
  catch {
    return false
  }
}

function moved(git: GitRun, repo: string, from: string, to: string): boolean {
  try {
    git(repo, ['worktree', 'move', from, to])
    return true
  }
  catch {
    return false
  }
}

export function takeFreeTree(git: GitRun, repo: string, target: string, settle: (tree: string) => void): boolean {
  for (const free of freeTreesIn(git, repo, freeTreeHome(target))) {
    if (!moved(git, repo, free, target))
      continue
    if (settled(git, target, settle))
      return true
    git(repo, ['worktree', 'remove', '--force', target])
  }
  return false
}

function excludedFromIndexing(home: string): boolean {
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, NEVER_INDEX_MARKER), '')
    return true
  }
  catch {
    return false
  }
}

export interface TreeDeps {
  cwd: string
  git: (cwd: string, args: string[]) => string
  install: (cwd: string, args: string[]) => void
  exists: (target: string) => boolean
  worktreeHome?: string
  treeOf?: (id: string) => string
}

export type TreeOrigin = 'reused' | 'cut'

const TREE_ORIGIN_LABEL = 'tree_origin'

export function treeOriginLine(origin: TreeOrigin): string {
  return `${TREE_ORIGIN_LABEL}: ${origin}`
}

export function treeOriginIn(output: string): TreeOrigin | null {
  const found = new RegExp(`^${TREE_ORIGIN_LABEL}: (reused|cut)$`, 'm').exec(output)
  return found === null ? null : found[1] as TreeOrigin
}

export interface ReadyTree {
  worktree: string
  origin?: TreeOrigin
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

function undoFailedAdd(deps: TreeDeps, repo: string, worktree: string, branch: string): string {
  try {
    if (deps.exists(worktree))
      deps.git(repo, ['worktree', 'remove', '--force', worktree])
    deps.git(repo, ['worktree', 'prune'])
    if (!branchExists(deps, repo, branch))
      return 'nothing written'
    deps.git(repo, ['branch', '-D', branch])
    return `branch ${branch} was removed; nothing written`
  }
  catch (error) {
    return `removing what the failed add left failed (${firstLine(error)}); remove ${worktree} and branch ${branch} by hand`
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

function reuseFreeTree(deps: TreeDeps, repo: string, worktree: string, branch: string): boolean | string {
  try {
    if (takeFreeTree(deps.git, repo, worktree, tree => deps.git(tree, ['checkout', '-q', '-f', '--no-track', '-B', branch, 'origin/main'])))
      return true
    if (branchExists(deps, repo, branch))
      deps.git(repo, ['branch', '-D', branch])
    return false
  }
  catch (error) {
    return gitMessage(error)
  }
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
  const unindexed = deps.treeOf === undefined || excludedFromIndexing(path.dirname(worktree))
  const reused = reuseFreeTree(deps, repo, worktree, branch)
  if (typeof reused === 'string')
    return { refused: `could not cut ${worktree}: ${reused}; nothing written` }
  if (!reused) {
    try {
      deps.git(repo, ['worktree', 'add', '-b', branch, worktree, 'origin/main'])
    }
    catch (error) {
      const recovered = recoverCheckout(deps, worktree, error)
      if (recovered === null) {
        const message = gitMessage(error)
        return { refused: `could not cut ${worktree}: ${message}; ${ADD_FOUND_ANOTHER_CUT.test(message) ? 'nothing written' : undoFailedAdd(deps, repo, worktree, branch)}` }
      }
      if (!Array.isArray(recovered))
        return { refused: `could not cut ${worktree}: ${recovered.failed}; ${undoFailedAdd(deps, repo, worktree, branch)}` }
      absent = recovered
    }
  }
  const installArgs = deps.exists(path.join(worktree, LOCKFILE)) ? FROZEN_INSTALL_ARGS : LOCKLESS_INSTALL_ARGS
  try {
    deps.install(worktree, installArgs)
  }
  catch (error) {
    return { refused: `pnpm ${installArgs.join(' ')} failed in ${worktree}: ${firstLine(error)}; ${removeTree(deps, repo, worktree, branch)}; nothing written` }
  }
  const left = `${absent.length === 0 ? '' : `; absent from the tree, kept out of git status with skip-worktree because the sandbox refused the write: ${absent.join(', ')}`}${unindexed ? '' : `; the Spotlight marker could not be written in ${path.dirname(worktree)}`}`
  return { worktree, origin: reused ? 'reused' : 'cut', how: `${reused ? 'reused a free tree as' : 'cut'} ${worktree} from origin/main${left}`, failedAppend: `${worktree} was cut on ${branch}${left}` }
}
