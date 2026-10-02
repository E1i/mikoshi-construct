import type { GitReader } from './git.js'
import type { Attempt } from './handoff.js'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface Tree {
  worktree: string
  branch: string | undefined
  gone: boolean
  dirty: number | undefined
}

export interface Unregistered {
  worktree: string
  branch: string | undefined
  dirty: number | undefined
  scratch: boolean
}

export function readTree(attempt: Attempt, git: GitReader): Tree | undefined {
  if (attempt.worktree === undefined)
    return undefined
  const gone = !existsSync(attempt.worktree)
  return { worktree: attempt.worktree, branch: attempt.branch, gone, dirty: gone ? undefined : git.dirty(attempt.worktree) }
}

export function treeText(tree: Tree | undefined): string {
  if (tree === undefined)
    return '—'
  if (tree.gone)
    return 'gone'
  return `${path.basename(tree.worktree)} · ${tree.branch ?? '?'} · dirty ${tree.dirty ?? '?'}`
}

export function readUnregistered(repoRoot: string | undefined, attempts: Attempt[], git: GitReader): Unregistered[] {
  if (repoRoot === undefined)
    return []
  const [main, ...others] = git.worktrees(repoRoot) ?? []
  if (main === undefined)
    return []
  const named = new Set(attempts.flatMap(attempt => attempt.worktree === undefined ? [] : [path.resolve(attempt.worktree)]))
  return others
    .filter(entry => !named.has(path.resolve(entry.path)))
    .map(entry => ({ worktree: entry.path, branch: entry.branch, dirty: git.dirty(entry.path), scratch: entry.path.includes('/scratchpad/') }))
}

export function unregisteredText(tree: Unregistered): string {
  return `${tree.worktree} ${tree.branch ?? 'detached'} dirty ${tree.dirty ?? '?'}`
}
