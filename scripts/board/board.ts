import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { colourFor } from '../../src/ui/signal.js'
import { sleep } from '../ghosts/every.js'
import { writeFrameFile } from './frame.js'
import { execGh } from './gh.js'
import { execGit, windowsRoot } from './git.js'
import { runBoardLoop } from './loop.js'
import { HANDOFF_DIR_VARIABLE, PREFIX, runBoard } from './run.js'

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

process.exitCode = await runBoardLoop({
  draw: now => runBoard(process.argv.slice(2), { gh: execGh, now, defaultDir, colour, repoRoot, session: process.env.CLAUDE_CODE_SESSION_ID }),
  now: () => new Date(),
  sleep,
  isTTY: process.stdout.isTTY === true,
  out: text => process.stdout.write(text),
  err: text => process.stderr.write(text),
  writeFrame,
})
