import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CARD_VARIABLE = 'CONSTRUCT_CARD'
export const ENTRYPOINT_VARIABLE = 'CLAUDE_CODE_ENTRYPOINT'
export const HEADLESS_ENTRYPOINT = 'sdk-cli'
export const WORKTREE_HOME_VARIABLE = 'CONSTRUCT_WORKTREE_HOME'
export const DEFAULT_WORKTREE_HOME = path.join(os.homedir(), '.construct', 'worktrees')

const RAISED_VARIABLE = 'CONSTRUCT_BUS_RAISED'
const RAISED_MARK = '1'
const WINDOW_VARIABLE = 'MIKO_WINDOW'
const WINDOW_MARK = '1'
const TAB_MARK = 'tab'
const LOOP_PID_VARIABLE = 'MIKO_LOOP_PID'
const EXIT_REQUEST_VARIABLE = 'MIKO_EXIT_REQUEST'
const BUS_FILE = 'bus.db'
const BUS_TREES = ['bus', 'worktrees']

export function worktreeHome(env) {
  const set = env[WORKTREE_HOME_VARIABLE]
  return set === undefined || set === '' ? DEFAULT_WORKTREE_HOME : set
}

export function worktreeHomesOf(env) {
  return [worktreeHome(env), DEFAULT_WORKTREE_HOME]
}

export function underTheLoop(env) {
  return env[WINDOW_VARIABLE] === WINDOW_MARK || Boolean(env[LOOP_PID_VARIABLE]) || Boolean(env[EXIT_REQUEST_VARIABLE])
}

export function isCardSession(env) {
  return Boolean(env[CARD_VARIABLE])
}

export function tabCandidate(env) {
  return !isCardSession(env) && !underTheLoop(env) && env[ENTRYPOINT_VARIABLE] !== HEADLESS_ENTRYPOINT && env[RAISED_VARIABLE] !== RAISED_MARK
}

export function startedByMiko(env) {
  return !isCardSession(env) && (underTheLoop(env) || (tabCandidate(env) && env[WINDOW_VARIABLE] === TAB_MARK))
}

function isInside(dir, home) {
  const relative = path.relative(path.resolve(home), path.resolve(dir))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isBusTreeHome(dir) {
  const [busDir, treesDir] = BUS_TREES
  return path.basename(dir) === treesDir && path.basename(path.dirname(dir)) === busDir && existsSync(path.join(path.dirname(path.dirname(dir)), BUS_FILE))
}

function insideBusTreeHome(dir) {
  for (let home = path.dirname(path.resolve(dir)); home !== path.dirname(home); home = path.dirname(home)) {
    if (isBusTreeHome(home))
      return true
  }
  return false
}

export function inCardTree(dir, treeHomes) {
  return treeHomes.some(home => isInside(dir, home)) || insideBusTreeHome(dir)
}

export function isTabWindowIn(env, dir, treeHomes) {
  return tabCandidate(env) && env[WINDOW_VARIABLE] === TAB_MARK && !inCardTree(dir, treeHomes)
}
