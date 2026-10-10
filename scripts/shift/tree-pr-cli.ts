import type { TreePr, TreePrPorts } from './tree-pr.js'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { execGh } from '../board/gh.js'
import { shiftTreeCard, treePr } from './tree-pr.js'

export const PREFIX = '[shift:tree-pr] '

const REAL_PORTS: TreePrPorts = {
  git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  gh: execGh,
}

function outcomeLine(cardFile: string, outcome: TreePr): string {
  if (outcome.kind === 'pr')
    return `${PREFIX}${path.basename(cardFile)}: PR #${outcome.number}`
  if (outcome.kind === 'clean')
    return `${PREFIX}${path.basename(cardFile)}: nothing to commit or push`
  return `${PREFIX}${path.basename(cardFile)}: ${outcome.why}`
}

export function runTreePr(argv: string[], ports: TreePrPorts = REAL_PORTS, out: (line: string) => void = line => process.stdout.write(`${line}\n`)): number {
  const [cardFile, worktree] = argv
  if (cardFile === undefined || worktree === undefined) {
    out(`${PREFIX}usage: tree-pr <parking card file> <worktree>`)
    return 2
  }
  const parsed = parseParkingFile(path.basename(cardFile), readFileSync(cardFile, 'utf8'))
  if (parsed.kind === 'refused') {
    out(`${PREFIX}${path.basename(cardFile)}: ${parsed.reason}`)
    return 1
  }
  const outcome = treePr(ports, shiftTreeCard(parsed.parked.task), worktree)
  out(outcomeLine(cardFile, outcome))
  return outcome.kind === 'problem' ? 1 : 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runTreePr(process.argv.slice(2))
