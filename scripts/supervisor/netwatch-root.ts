import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { watchTheNetwork } from '../ports/netwatch.js'
import { PR_HISTORY, requiredCheckAt } from './composition.js'

export function standaloneRequiredCheck(): string {
  return requiredCheckAt()
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await watchTheNetwork(standaloneRequiredCheck, process.argv.includes('--once'), PR_HISTORY)
