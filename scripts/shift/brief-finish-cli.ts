import type { CardBodyReader } from '../bus/parking-reads.js'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { defaultBusPath } from '../bus/db.js'
import { busCardBodies } from '../bus/parking-reads.js'
import { runPnpmCommand } from '../ghosts/install.js'
import { finishBrief } from './brief-finish.js'

export const PREFIX = '[shift:brief-finish] '

const CARD_NUMBER = /^[1-9]\d*$/

export const REAL_DEPS = {
  cwd: process.cwd(),
  git: (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] }),
  read: (file: string) => readFileSync(file, 'utf8'),
  pnpm: runPnpmCommand,
}

export function runBriefFinish(argv: string[], deps: Parameters<typeof finishBrief>[0] = REAL_DEPS, out: (line: string) => void = line => process.stdout.write(`${line}\n`), bodyOf: CardBodyReader = busCardBodies(defaultBusPath())): number {
  const [card, worktree, brief] = argv
  if (card === undefined || !CARD_NUMBER.test(card) || worktree === undefined || brief === undefined) {
    out(`${PREFIX}usage: brief-finish <card number> <worktree> <brief>`)
    return 2
  }
  const text = bodyOf(Number(card))
  if (text === null) {
    out(`${PREFIX}#${card}: the bus holds no card body of card #${card}`)
    return 1
  }
  const parsed = parseParkingFile(`${card}.md`, text)
  if (parsed.kind === 'refused') {
    out(`${PREFIX}#${card}: ${parsed.reason}`)
    return 1
  }
  const problem = finishBrief(deps, worktree, parsed.parked.task.card, brief)
  if (problem !== null) {
    out(`${PREFIX}#${card}: ${problem}`)
    return 1
  }
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBriefFinish(process.argv.slice(2))
