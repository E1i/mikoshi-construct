import type { Status } from '../core/handoff-status.js'
import type { WindowSession } from './window-heartbeat.js'
import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isTabWindowIn, tabCandidate, worktreeHomesOf } from '../../.claude/hooks/tab-window.mjs'
import { isOwnerCheckout, REPO_ID_SEPARATOR, repoIdOf } from '../core/bus-path.js'
import { statusOfFile } from '../core/handoff-status.js'
import { clientAdapter } from '../ports/client/index.js'
import { windowModeOf } from '../ports/session.js'
import { busWorktreeHome } from '../ports/worktree-home.js'
import { PREFIX } from './loop.js'
import { windowOf } from './window-heartbeat.js'

export { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../.claude/hooks/tab-window.mjs'

export const NO_WINDOW = 'this session was not started by miko, so it is no window and nothing was done: start the window with miko (the loop) or miko --tab (a tab window), through pnpm in the repository that declares it as a script'
export const PROMPT_REFUSED_EXIT = 2

const OWNER_WINDOW = 'the owner checkout'
const ADDRESSED_HANDOFF = /\.construct\/(?:([\w.-]+)\/)?handoff\/miko\.md/

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
  return handoff === null ? null : statusOfFile(handoff) ?? null
}

export function noWindowRefusal(env: NodeJS.ProcessEnv): string | null {
  const isClientSession = clientAdapter().ownSession(env) !== null
  return isClientSession && tabCandidate(env) && windowModeOf(env) === null ? NO_WINDOW : null
}

function windowNameOf(repository: string | null): string {
  return repository === null ? OWNER_WINDOW : repository.replace(REPO_ID_SEPARATOR, '/')
}

export function misaddressedPromptRefusal(prompt: string, env: NodeJS.ProcessEnv, dir: string): string | null {
  if (windowModeOf(env) === null && !tabCandidate(env))
    return null
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? ''
  const address = ADDRESSED_HANDOFF.exec(firstLine)
  if (address === null)
    return null
  const addressed = address[1] ?? null
  const inOwnerCheckout = isOwnerCheckout(dir)
  const own = repoIdOf(dir)
  if (addressed === null ? inOwnerCheckout : addressed === own)
    return null
  return `${PREFIX}this prompt is addressed to the window of ${windowNameOf(addressed)}, and this session runs in ${windowNameOf(inOwnerCheckout ? null : own)} (${dir}): nothing was done here. Send it to the window of ${windowNameOf(addressed)}, started in that repository with miko`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refusal = misaddressedPromptRefusal(readFileSync(0, 'utf8'), process.env, process.cwd())
  if (refusal !== null) {
    console.error(refusal)
    process.exitCode = PROMPT_REFUSED_EXIT
  }
}
