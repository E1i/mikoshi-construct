import type { Status } from './loop.js'
import type { WindowSession } from './window-heartbeat.js'
import { existsSync, readFileSync } from 'node:fs'
import { raisedByTheBus } from '../nodes/restart/role.js'
import { statusOf } from './loop.js'
import { windowOf } from './window-heartbeat.js'

export const ENTRYPOINT_VARIABLE = 'CLAUDE_CODE_ENTRYPOINT'
export const HEADLESS_ENTRYPOINT = 'sdk-cli'

export function tabWindowOf(env: NodeJS.ProcessEnv): WindowSession | null {
  const window = windowOf(env)
  return window?.mode === 'tab' && env[ENTRYPOINT_VARIABLE] !== HEADLESS_ENTRYPOINT && !raisedByTheBus(env) ? window : null
}

export function handoffStatusOf(handoff: string | null): Status | null {
  return handoff !== null && existsSync(handoff) ? statusOf(readFileSync(handoff, 'utf8')) : null
}
