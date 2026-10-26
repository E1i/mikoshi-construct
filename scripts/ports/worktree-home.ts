import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { busDirOf } from '../core/bus-path.js'

export const WORKTREE_HOME_VARIABLE = 'CONSTRUCT_WORKTREE_HOME'
export const DEFAULT_WORKTREE_HOME = path.join(os.homedir(), '.construct', 'worktrees')

export function worktreeHome(env: NodeJS.ProcessEnv): string {
  const set = env[WORKTREE_HOME_VARIABLE]
  return set === undefined || set === '' ? DEFAULT_WORKTREE_HOME : set
}

export function taskWorktree(home: string, id: string): string {
  return path.join(home, `mc-${id}`)
}

export function cardTree(env: NodeJS.ProcessEnv, busPath: string, id: string, oldHome: string = DEFAULT_WORKTREE_HOME, exists: (target: string) => boolean = existsSync): string {
  const set = env[WORKTREE_HOME_VARIABLE]
  if (set !== undefined && set !== '')
    return taskWorktree(set, id)
  const old = taskWorktree(oldHome, id)
  return exists(old) ? old : path.join(busDirOf(busPath), 'worktrees', id)
}
