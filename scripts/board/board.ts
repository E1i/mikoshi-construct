import process from 'node:process'
import { execGh } from './gh.js'
import { runBoard } from './run.js'

const result = runBoard(process.argv.slice(2), { gh: execGh, now: new Date() })
for (const line of result.stderr)
  process.stderr.write(`${line}\n`)
if (result.stdout.length > 0)
  process.stdout.write(`${result.stdout.join('\n')}\n`)
process.exitCode = result.exitCode
