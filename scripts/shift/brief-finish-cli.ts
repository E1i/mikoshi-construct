import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { runPnpmCommand } from '../ghosts/pnpm-runner.js'
import { finishBrief } from './brief-finish.js'

export const PREFIX = '[shift:brief-finish] '

export const REAL_DEPS = {
  cwd: process.cwd(),
  git: (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] }),
  read: (file: string) => readFileSync(file, 'utf8'),
  pnpm: runPnpmCommand,
}

export function runBriefFinish(argv: string[], deps: Parameters<typeof finishBrief>[0] = REAL_DEPS, out: (line: string) => void = line => process.stdout.write(`${line}\n`)): number {
  const [cardFile, worktree, brief] = argv
  if (cardFile === undefined || worktree === undefined || brief === undefined) {
    out(`${PREFIX}usage: brief-finish <parking card file> <worktree> <brief>`)
    return 2
  }
  if (!existsSync(cardFile)) {
    out(`${PREFIX}${path.basename(cardFile)}: the card file ${cardFile} is gone`)
    return 1
  }
  const parsed = parseParkingFile(path.basename(cardFile), readFileSync(cardFile, 'utf8'))
  if (parsed.kind === 'refused') {
    out(`${PREFIX}${path.basename(cardFile)}: ${parsed.reason}`)
    return 1
  }
  const problem = finishBrief(deps, worktree, parsed.parked.task.card, brief)
  if (problem !== null) {
    out(`${PREFIX}${path.basename(cardFile)}: ${problem}`)
    return 1
  }
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBriefFinish(process.argv.slice(2))
