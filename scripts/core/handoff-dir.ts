import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { constructHome, isOwnerCheckout, repoHome, repoIdOf } from './bus-path.js'

export const HANDOFF_DIR_VARIABLE = 'CONSTRUCT_HANDOFF_DIR'
export const HANDOFF_DIR = 'handoff'

export function handoffDirOf(env: NodeJS.ProcessEnv, home: string, dir: string): string {
  const named = env[HANDOFF_DIR_VARIABLE]
  if (named !== undefined && named !== '')
    return named
  return path.join(isOwnerCheckout(dir) ? constructHome(home) : repoHome(home, repoIdOf(dir)), HANDOFF_DIR)
}

export function defaultHandoffDir(): string {
  return handoffDirOf(process.env, os.homedir(), process.cwd())
}
