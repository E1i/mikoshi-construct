import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { sessionHandoffOf } from '../shift/handoff-write.js'
import { CONTINUE_PROMPT } from './loop.js'
import { tabWindowOf } from './tab.js'

export function compactContextOf(env: NodeJS.ProcessEnv, handoffExists: (file: string) => boolean): string | null {
  const handoff = sessionHandoffOf(env, os.homedir())
  return tabWindowOf(env) !== null && handoff !== null && handoffExists(handoff) ? CONTINUE_PROMPT : null
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const context = compactContextOf(process.env, existsSync)
  if (context !== null)
    process.stdout.write(context)
}
