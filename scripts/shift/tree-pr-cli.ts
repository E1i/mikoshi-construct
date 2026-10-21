import type { DatabaseSync } from 'node:sqlite'
import type { TreePr, TreePrPorts } from './tree-pr.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { PR_OPENED } from '../bus/card-automaton.js'
import { cardContract } from '../bus/card-contract.js'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath, openBus } from '../bus/db.js'
import { CARD_STARTED, CARD_STOPPED } from '../bus/inbox.js'
import { openDatabase } from '../bus/sqlite.js'
import { execGh, stdoutOrThrow } from '../core/gh.js'
import { shiftTreeCard, treePr } from './tree-pr.js'

export const PREFIX = '[shift:tree-pr] '

export interface TreePrCliPorts extends TreePrPorts {
  card: (cardId: number) => string | null
  opened: (cardId: number, pr: number) => void
  stopped: (cardId: number, why: string) => void
}

export interface PrOpenedBus {
  busPath: string
  pid: number
  now: () => Date
  err: (line: string) => void
}

interface ShiftEvent {
  type: string
  cardId: number
  pr: number | null
  dedupeKey: string
  payload: Record<string, unknown>
}

const LATEST_START = `SELECT dedupe_key FROM events WHERE type = '${CARD_STARTED}' AND legacy = 0 AND card_id = ? ORDER BY id DESC LIMIT 1`

function appendShiftEvent(bus: PrOpenedBus, what: string, event: (db: DatabaseSync) => ShiftEvent): void {
  try {
    const db = openBus(bus.busPath)
    try {
      const ts = bus.now().toISOString()
      appendEvent(db, { ts, actor: `worker:shift:${bus.pid}`, head: null, legacy: false, ...event(db) })
    }
    finally {
      db.close()
    }
  }
  catch (error) {
    bus.err(`${PREFIX}${what} not written to ${bus.busPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function busPrOpened(bus: PrOpenedBus): TreePrCliPorts['opened'] {
  return (cardId, pr) => appendShiftEvent(bus, `${PR_OPENED} of PR #${pr}`, () => ({ type: PR_OPENED, cardId, pr, dedupeKey: `${PR_OPENED}:${cardId}:${pr}`, payload: { pr } }))
}

export function busCardStopped(bus: PrOpenedBus): TreePrCliPorts['stopped'] {
  return (cardId, why) => appendShiftEvent(bus, `${CARD_STOPPED} of card #${cardId}`, (db) => {
    const start = db.prepare(LATEST_START).get(cardId) as { dedupe_key: string } | undefined
    if (start === undefined)
      throw new Error(`card #${cardId} has no ${CARD_STARTED} to stop`)
    return { type: CARD_STOPPED, cardId, pr: null, dedupeKey: `${CARD_STOPPED}:tree-pr:${start.dedupe_key}`, payload: { reason: 'fault', detail: `tree-pr: card #${cardId}: ${why}` } }
  })
}

export function busCardText(busPath: string): TreePrCliPorts['card'] {
  return (cardId) => {
    if (!existsSync(busPath))
      return null
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return cardContract(db, cardId)?.text ?? null
    }
    finally {
      db.close()
    }
  }
}

const REAL_BUS: PrOpenedBus = { busPath: defaultBusPath(), pid: process.pid, now: () => new Date(), err: line => process.stderr.write(`${line}\n`) }

const REAL_PORTS: TreePrCliPorts = {
  git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  gh: stdoutOrThrow(execGh),
  card: busCardText(REAL_BUS.busPath),
  opened: busPrOpened(REAL_BUS),
  stopped: busCardStopped(REAL_BUS),
}

function cardIdOf(word: string): number | null {
  return /^[1-9]\d*$/.test(word) ? Number(word) : null
}

function outcomeLine(cardId: number, outcome: Exclude<TreePr, { kind: 'problem' }>): string {
  if (outcome.kind === 'pr')
    return `${PREFIX}card #${cardId}: PR #${outcome.number}`
  return `${PREFIX}card #${cardId}: nothing to commit or push`
}

export function runTreePr(argv: string[], ports: TreePrCliPorts = REAL_PORTS, out: (line: string) => void = line => process.stdout.write(`${line}\n`)): number {
  const [cardWord, worktree, report] = argv
  const cardId = cardWord === undefined ? null : cardIdOf(cardWord)
  if (cardId === null || worktree === undefined) {
    out(`${PREFIX}usage: tree-pr <card id> <worktree> [<session report>]`)
    return 2
  }
  const refuse = (why: string): number => {
    ports.stopped(cardId, why)
    out(`${PREFIX}card #${cardId}: ${why}`)
    return 1
  }
  const text = ports.card(cardId)
  if (text === null)
    return refuse(`the bus holds no card body of card #${cardId} that parses; the tree is left uncommitted`)
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind === 'refused')
    return refuse(parsed.reason)
  const outcome = treePr(ports, shiftTreeCard(parsed.parked.task), worktree, report !== undefined && existsSync(report) ? readFileSync(report, 'utf8') : null)
  if (outcome.kind === 'problem')
    return refuse(outcome.why)
  if (outcome.kind === 'pr')
    ports.opened(cardId, Number(outcome.number))
  out(outcomeLine(cardId, outcome))
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runTreePr(process.argv.slice(2))
