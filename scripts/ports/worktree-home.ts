import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { busDirOf } from '../core/bus-path.js'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { CARD_STARTED } from '../core/events.js'
import { openDatabase } from '../core/sqlite.js'

export const WORKTREE_HOME_VARIABLE = 'CONSTRUCT_WORKTREE_HOME'
export const DEFAULT_WORKTREE_HOME = path.join(os.homedir(), '.construct', 'worktrees')

export function worktreeHome(env: NodeJS.ProcessEnv): string {
  const set = env[WORKTREE_HOME_VARIABLE]
  return set === undefined || set === '' ? DEFAULT_WORKTREE_HOME : set
}

export function taskWorktree(home: string, id: string): string {
  return path.join(home, `mc-${id}`)
}

export function busWorktreeHome(busPath: string): string {
  return path.join(busDirOf(busPath), 'worktrees')
}

const STARTED_TREE = `
  SELECT json_extract(payload, '$.worktree') AS worktree FROM events
  WHERE legacy = 0 AND type = '${CARD_STARTED}' AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.worktree') = 'text'
  ORDER BY id DESC LIMIT 1
`

export type StartedTreeReader = (busPath: string, id: string) => string | null

export function busStartedTree(busPath: string, id: string): string | null {
  if (!existsSync(busPath))
    return null
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const row = db.prepare(STARTED_TREE).get(Number(id)) as { worktree: string } | undefined
    return row?.worktree ?? null
  }
  finally {
    db.close()
  }
}

function oldBusOf(oldHome: string): string {
  return path.join(path.dirname(oldHome), 'bus.db')
}

export function cardTree(env: NodeJS.ProcessEnv, busPath: string, id: string, oldHome: string = DEFAULT_WORKTREE_HOME, exists: (target: string) => boolean = existsSync, startedTree: StartedTreeReader = busStartedTree): string {
  const set = env[WORKTREE_HOME_VARIABLE]
  if (set !== undefined && set !== '')
    return taskWorktree(set, id)
  const old = taskWorktree(oldHome, id)
  const oldIsThisBus = path.resolve(busPath) === path.resolve(oldBusOf(oldHome))
  const keepsOld = exists(old) && (oldIsThisBus || startedTree(busPath, id) === old)
  return keepsOld ? old : path.join(busWorktreeHome(busPath), id)
}

export function cardTreeRoots(env: NodeJS.ProcessEnv, busPath: string, repo: string): { homes: string[], perBus: string } {
  const perBus = busWorktreeHome(busPath)
  return { homes: [worktreeHome(env), DEFAULT_WORKTREE_HOME, perBus, path.dirname(repo)], perBus }
}
