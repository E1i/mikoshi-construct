import type { Status } from './loop.js'
import type { WindowSession } from './window-heartbeat.js'
import { existsSync, readFileSync } from 'node:fs'
import { isTabWindowIn, tabCandidate, worktreeHomesOf } from '../../.claude/hooks/tab-window.mjs'
import { busWorktreeHome } from '../ports/worktree-home.js'
import { statusOf } from './loop.js'
import { windowOf } from './window-heartbeat.js'

export { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../.claude/hooks/tab-window.mjs'

export function tabWindowOf(env: NodeJS.ProcessEnv): WindowSession | null {
  return tabCandidate(env) ? windowOf(env) : null
}

export function cardTreeHomes(env: NodeJS.ProcessEnv, busPath: string): string[] {
  return [...worktreeHomesOf(env), busWorktreeHome(busPath)]
}

export function tabWindowIn(env: NodeJS.ProcessEnv, dir: string, treeHomes: readonly string[]): WindowSession | null {
  return isTabWindowIn(env, dir, treeHomes) ? windowOf(env) : null
}

export function handoffStatusOf(handoff: string | null): Status | null {
  return handoff !== null && existsSync(handoff) ? statusOf(readFileSync(handoff, 'utf8')) : null
}
