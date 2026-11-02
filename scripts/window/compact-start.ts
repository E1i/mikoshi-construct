import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath } from '../core/db.js'
import { sessionHandoffOf } from './handoff-write.js'
import { repositoryContinuePrompt } from './loop.js'
import { cardTreeHomes, tabWindowIn, tabWindowOf } from './tab.js'

export const COMPACT_SOURCE = 'compact'
export const TAB_MARK_DIR = path.join('.construct', 'eddies.d', 'tab')
const MARKABLE_SESSION = /^[\w-]{1,128}$/
export const WAKE_UP = 'wake-up: when the last STATUS: of the handoff is CONTINUE, set your own wake-up now, nothing by hand — CronCreate on */15 * * * * with the prompt "D-275 pass", and Monitor on pnpm miko:watch of this repository\'s bus with a 20-minute idle timeout; each wake-up is one D-275 pass: the highest-priority stuck open PR first, then the next card by priority'

export function sourceOf(input: string): string | null {
  try {
    const source = (JSON.parse(input) as { source?: unknown } | null)?.source
    return typeof source === 'string' ? source : null
  }
  catch {
    return null
  }
}

export function compactContextOf(source: string | null, env: NodeJS.ProcessEnv, handoffExists: (file: string) => boolean, dir: string = process.cwd()): string | null {
  if (source !== COMPACT_SOURCE)
    return null
  const handoff = sessionHandoffOf(env, os.homedir(), dir)
  return tabWindowOf(env) !== null && handoff !== null && handoffExists(handoff) ? repositoryContinuePrompt(dir, handoff) : null
}

export function startContextOf(source: string | null, env: NodeJS.ProcessEnv, handoffExists: (file: string) => boolean, dir: string, treeHomes: readonly string[]): string | null {
  if (tabWindowIn(env, dir, treeHomes) === null)
    return null
  return [compactContextOf(source, env, handoffExists, dir), WAKE_UP].filter(line => line !== null).join('\n\n')
}

export function markTabWindow(root: string, env: NodeJS.ProcessEnv, treeHomes: readonly string[]): string | null {
  const session = tabWindowIn(env, root, treeHomes)?.session
  if (session === undefined || !MARKABLE_SESSION.test(session))
    return null
  const mark = path.join(root, TAB_MARK_DIR, session)
  mkdirSync(path.dirname(mark), { recursive: true })
  writeFileSync(mark, '')
  return mark
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const treeHomes = cardTreeHomes(process.env, defaultBusPath())
  markTabWindow(process.cwd(), process.env, treeHomes)
  const context = startContextOf(sourceOf(readFileSync(0, 'utf8')), process.env, existsSync, process.cwd(), treeHomes)
  if (context !== null)
    process.stdout.write(context)
}
