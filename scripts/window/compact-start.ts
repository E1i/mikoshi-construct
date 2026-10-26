import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { sessionHandoffOf } from './handoff-write.js'
import { repositoryContinuePrompt } from './loop.js'
import { tabWindowOf } from './tab.js'

export const COMPACT_SOURCE = 'compact'

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

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const context = compactContextOf(sourceOf(readFileSync(0, 'utf8')), process.env, existsSync)
  if (context !== null)
    process.stdout.write(context)
}
