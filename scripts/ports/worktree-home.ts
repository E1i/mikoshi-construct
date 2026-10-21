import os from 'node:os'
import path from 'node:path'

export const WORKTREE_HOME_VARIABLE = 'CONSTRUCT_WORKTREE_HOME'
export const DEFAULT_WORKTREE_HOME = path.join(os.homedir(), '.construct', 'worktrees')

export function worktreeHome(env: NodeJS.ProcessEnv): string {
  const set = env[WORKTREE_HOME_VARIABLE]
  return set === undefined || set === '' ? DEFAULT_WORKTREE_HOME : set
}

export function taskWorktree(home: string, id: string): string {
  return path.join(home, `mc-${id}`)
}
