import type { SessionOwner } from './window-heartbeat.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath } from '../core/db.js'
import { MIKO_WATCH_COMMAND } from '../core/owner-commands.js'
import { claudeAdapterWith } from '../ports/client/claude/adapter.js'
import { settingsFlag, shiftSettings } from '../ports/shift-settings.js'
import { sessionHandoffOf } from './handoff-write.js'
import { repositoryContinuePrompt } from './loop.js'
import { cardTreeHomes, tabWindowIn, tabWindowOf } from './tab.js'

export const COMPACT_SOURCE = 'compact'
export const WAKE_UP = `wake-up: when the last STATUS: of the handoff is CONTINUE, set your own wake-up now, nothing by hand — CronCreate on */15 * * * * with the prompt "D-275 pass", and Monitor on ${MIKO_WATCH_COMMAND} of this repository's bus with a 20-minute idle timeout; each wake-up is one D-275 pass: the highest-priority stuck open PR first, then the next card by priority`

export function sourceOf(input: string): string | null {
  try {
    const source = (JSON.parse(input) as { source?: unknown } | null)?.source
    return typeof source === 'string' ? source : null
  }
  catch {
    return null
  }
}

export function compactContextOf(client: SessionOwner, source: string | null, env: NodeJS.ProcessEnv, handoffExists: (file: string) => boolean, dir: string = process.cwd()): string | null {
  if (source !== COMPACT_SOURCE)
    return null
  const handoff = sessionHandoffOf(env, os.homedir(), dir)
  return tabWindowOf(client, env) !== null && handoff !== null && handoffExists(handoff) ? repositoryContinuePrompt(dir, handoff) : null
}

export function startContextOf(client: SessionOwner, source: string | null, env: NodeJS.ProcessEnv, handoffExists: (file: string) => boolean, dir: string, treeHomes: readonly string[]): string | null {
  if (tabWindowIn(client, env, dir, treeHomes) === null)
    return null
  return [compactContextOf(client, source, env, handoffExists, dir), WAKE_UP].filter(line => line !== null).join('\n\n')
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const treeHomes = cardTreeHomes(process.env, defaultBusPath())
  const context = startContextOf(claudeAdapterWith({ shiftSettings, settingsFlag }), sourceOf(readFileSync(0, 'utf8')), process.env, existsSync, process.cwd(), treeHomes)
  if (context !== null)
    process.stdout.write(context)
}
