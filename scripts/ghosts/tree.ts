import type { GitReader } from '../core/git.js'
import type { Attempt } from './handoff.js'
import path from 'node:path'

export interface Unregistered {
  worktree: string
  branch: string | undefined
  dirty: number | undefined
  scratch: boolean
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
