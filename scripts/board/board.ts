import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { sleep } from '../ghosts/every.js'
import { frameText, writeFrameFile } from './frame.js'
import { execGh } from './gh.js'
import { execGit, windowsRoot } from './git.js'
import { HANDOFF_DIR_VARIABLE, PREFIX, runBoard } from './run.js'
import { colourFor } from './tone.js'

const defaultDir = process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
const colour = colourFor(process.stdout.isTTY, process.env.NO_COLOR)
const repoRoot = windowsRoot(execGit, path.resolve(import.meta.dirname, '../..'))

function writeFrame(file: string, lines: string[]): void {
  try {
    writeFrameFile(file, lines)
  }
  catch (error) {
    process.stderr.write(`${PREFIX}could not write ${file}: ${(error as Error).message}\n`)
  }
}

async function main(): Promise<void> {
  for (;;) {
    const result = runBoard(process.argv.slice(2), { gh: execGh, now: new Date(), defaultDir, colour, repoRoot, session: process.env.CLAUDE_CODE_SESSION_ID })
    for (const line of result.stderr)
      process.stderr.write(`${line}\n`)
    const clear = result.everySeconds !== undefined && process.stdout.isTTY === true
    if (result.stdout.length > 0)
      process.stdout.write(frameText(result.stdout, clear))
    if (result.frameFile !== undefined)
      writeFrame(result.frameFile, result.stdout)
    process.exitCode = result.exitCode
    if (result.everySeconds === undefined)
      return
    await sleep(result.everySeconds * 1000)
  }
}

await main()
