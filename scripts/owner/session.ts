import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ownerSessionMain } from '../supervisor/session-view.js'

const COVERAGE_FLAG = '--coverage'

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = ownerSessionMain({ args: process.argv.slice(2), coverageFlag: COVERAGE_FLAG }, line => console.log(line))
