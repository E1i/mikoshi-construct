import type { WindowSession } from '../bus/window-heartbeat.js'
import type { Status } from './loop.js'
import { existsSync, readFileSync } from 'node:fs'
import { raisedByTheBus } from '../bus/role.js'
import { windowOf } from '../bus/window-heartbeat.js'
import { statusOf } from './loop.js'

export const ENTRYPOINT_VARIABLE = 'CLAUDE_CODE_ENTRYPOINT'
export const HEADLESS_ENTRYPOINT = 'sdk-cli'

export function tabWindowOf(env: NodeJS.ProcessEnv): WindowSession | null {
  const window = windowOf(env)
  return window?.mode === 'tab' && env[ENTRYPOINT_VARIABLE] !== HEADLESS_ENTRYPOINT && !raisedByTheBus(env) ? window : null
}

export function handoffStatusOf(handoff: string | null): Status | null {
  return handoff !== null && existsSync(handoff) ? statusOf(readFileSync(handoff, 'utf8')) : null
}
