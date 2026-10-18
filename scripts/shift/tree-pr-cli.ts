import type { TreePr, TreePrPorts } from './tree-pr.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { PR_OPENED } from '../bus/card-automaton.js'
import { appendEvent, defaultBusPath, openBus } from '../bus/db.js'
import { execGh } from '../core/gh.js'
import { shiftTreeCard, treePr } from './tree-pr.js'

export const PREFIX = '[shift:tree-pr] '

export interface TreePrCliPorts extends TreePrPorts {
  opened: (cardId: number, pr: number) => void
}

export interface PrOpenedBus {
  busPath: string
  pid: number
  now: () => Date
  err: (line: string) => void
}

export function busPrOpened(bus: PrOpenedBus): TreePrCliPorts['opened'] {
  return (cardId, pr) => {
    try {
      const db = openBus(bus.busPath)
      try {
        appendEvent(db, { ts: bus.now().toISOString(), type: PR_OPENED, actor: `worker:shift:${bus.pid}`, cardId, pr, head: null, dedupeKey: `${PR_OPENED}:${cardId}:${pr}`, payload: { pr }, legacy: false })
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      bus.err(`${PREFIX}${PR_OPENED} of PR #${pr} not written to ${bus.busPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const REAL_PORTS: TreePrCliPorts = {
  git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  gh: execGh,
  opened: busPrOpened({ busPath: defaultBusPath(), pid: process.pid, now: () => new Date(), err: line => process.stderr.write(`${line}\n`) }),
}

function outcomeLine(cardFile: string, outcome: TreePr): string {
  if (outcome.kind === 'pr')
    return `${PREFIX}${path.basename(cardFile)}: PR #${outcome.number}`
  if (outcome.kind === 'clean')
    return `${PREFIX}${path.basename(cardFile)}: nothing to commit or push`
  return `${PREFIX}${path.basename(cardFile)}: ${outcome.why}`
}

export function runTreePr(argv: string[], ports: TreePrCliPorts = REAL_PORTS, out: (line: string) => void = line => process.stdout.write(`${line}\n`)): number {
  const [cardFile, worktree, report] = argv
  if (cardFile === undefined || worktree === undefined) {
    out(`${PREFIX}usage: tree-pr <parking card file> <worktree> [<session report>]`)
    return 2
  }
  if (!existsSync(cardFile)) {
    out(`${PREFIX}${path.basename(cardFile)}: the card file ${cardFile} is gone (moved to another lane or archived while the session ran); the tree is left uncommitted`)
    return 1
  }
  const parsed = parseParkingFile(path.basename(cardFile), readFileSync(cardFile, 'utf8'))
  if (parsed.kind === 'refused') {
    out(`${PREFIX}${path.basename(cardFile)}: ${parsed.reason}`)
    return 1
  }
  const outcome = treePr(ports, shiftTreeCard(parsed.parked.task), worktree, report !== undefined && existsSync(report) ? readFileSync(report, 'utf8') : null)
  if (outcome.kind === 'pr')
    ports.opened(Number(parsed.parked.task.id), Number(outcome.number))
  out(outcomeLine(cardFile, outcome))
  return outcome.kind === 'problem' ? 1 : 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runTreePr(process.argv.slice(2))
