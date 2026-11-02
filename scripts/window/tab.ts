import type { Status } from './loop.js'
import type { WindowSession } from './window-heartbeat.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { raisedByTheBus } from '../nodes/restart/role.js'
import { busWorktreeHome, DEFAULT_WORKTREE_HOME, worktreeHome } from '../ports/worktree-home.js'
import { statusOf } from './loop.js'
import { windowOf } from './window-heartbeat.js'

export const ENTRYPOINT_VARIABLE = 'CLAUDE_CODE_ENTRYPOINT'
export const HEADLESS_ENTRYPOINT = 'sdk-cli'

export function tabWindowOf(env: NodeJS.ProcessEnv): WindowSession | null {
  const window = windowOf(env)
  return window?.mode === 'tab' && env[ENTRYPOINT_VARIABLE] !== HEADLESS_ENTRYPOINT && !raisedByTheBus(env) ? window : null
}

function isInside(dir: string, home: string): boolean {
  const relative = path.relative(path.resolve(home), path.resolve(dir))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function cardTreeHomes(env: NodeJS.ProcessEnv, busPath: string): string[] {
  return [worktreeHome(env), DEFAULT_WORKTREE_HOME, busWorktreeHome(busPath)]
}

export function tabWindowIn(env: NodeJS.ProcessEnv, dir: string, treeHomes: readonly string[]): WindowSession | null {
  return treeHomes.some(home => isInside(dir, home)) ? null : tabWindowOf(env)
}

export function handoffStatusOf(handoff: string | null): Status | null {
  return handoff !== null && existsSync(handoff) ? statusOf(readFileSync(handoff, 'utf8')) : null
}
