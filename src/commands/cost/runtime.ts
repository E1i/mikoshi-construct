import type { Runtime } from './source.js'
import process from 'node:process'
import { readManifest } from '../../manifest.js'

const CLAUDE_CODE_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']
const CURSOR_ENV = ['CURSOR_AGENT', 'CURSOR_TRACE_ID']

function anySet(env: NodeJS.ProcessEnv, names: string[]): boolean {
  return names.some(name => (env[name] ?? '') !== '')
}

export function resolveRuntime(root: string, env: NodeJS.ProcessEnv = process.env): Runtime {
  if (anySet(env, CLAUDE_CODE_ENV))
    return 'claude-code'
  if (anySet(env, CURSOR_ENV))
    return 'cursor'
  return readManifest(root)?.ai === 'cursor' ? 'cursor' : 'claude-code'
}
