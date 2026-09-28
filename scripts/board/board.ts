import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { sleep } from '../ghosts/every.js'
import { execGh } from './gh.js'
import { HANDOFF_DIR_VARIABLE, runBoard } from './run.js'

const defaultDir = process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')

async function main(): Promise<void> {
  for (;;) {
    const result = runBoard(process.argv.slice(2), { gh: execGh, now: new Date(), defaultDir })
    for (const line of result.stderr)
      process.stderr.write(`${line}\n`)
    if (result.stdout.length > 0)
      process.stdout.write(`${result.stdout.join('\n')}\n`)
    process.exitCode = result.exitCode
    if (result.everySeconds === undefined)
      return
    await sleep(result.everySeconds * 1000)
  }
}

await main()
