import type { DatabaseSync } from 'node:sqlite'
import type { Refusal, RefusalReason, TreeCard, TreePr, TreePrPorts } from './tree-pr.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { cardSessionOf } from '../bus/answer-source.js'
import { cardContract } from '../bus/card-contract.js'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath, openBus } from '../bus/db.js'
import { CARD_PERMISSION_MODE } from '../bus/launch-starter.js'
import { openDatabase } from '../bus/sqlite.js'
import { CARD_STARTED, CARD_STOPPED, CARD_WAITING, PR_OPENED, QUESTION_AGENT } from '../core/events.js'
import { execGh, stdoutOrThrow } from '../core/gh.js'
import { refusalOf, shiftTreeCard, treePr } from './tree-pr.js'

export const PREFIX = '[shift:tree-pr] '

export const RETURNED_TO_SESSION = 'tree-pr-return'

export interface TreePrWait {
  code: string
  detail: string
  widen: string[]
  touches: string[]
}

export interface TreePrCliPorts extends TreePrPorts {
  card: (cardId: number) => string | null
  opened: (cardId: number, pr: number) => void
  stopped: (cardId: number, why: string, code: string) => void
  waited: (cardId: number, wait: TreePrWait) => void
  lastRefusal: (cardId: number) => string | null
  returned: (cardId: number, code: string, why: string) => void
  resume: (cardId: number, worktree: string, prompt: string) => boolean
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

const LATEST_START = `SELECT id, dedupe_key FROM events WHERE type = '${CARD_STARTED}' AND legacy = 0 AND card_id = ? ORDER BY id DESC LIMIT 1`

const REFUSALS_SINCE = `
  SELECT json_extract(payload, '$.code') AS code FROM events
  WHERE card_id = ? AND legacy = 0 AND id > ? AND type IN ('${CARD_WAITING}', '${CARD_STOPPED}')
    AND json_valid(payload) AND json_type(payload, '$.code') = 'text'
  ORDER BY id DESC
`

interface LatestStart {
  id: number
  dedupe_key: string
}

function latestStartOf(db: DatabaseSync, cardId: number): LatestStart {
  const start = db.prepare(LATEST_START).get(cardId) as LatestStart | undefined
  if (start === undefined)
    throw new Error(`card #${cardId} has no ${CARD_STARTED} to stop`)
  return start
}

function refusalCodesSince(db: DatabaseSync, cardId: number, start: LatestStart): string[] {
  return (db.prepare(REFUSALS_SINCE).all(cardId, start.id) as { code: string }[]).map(row => row.code)
}

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
  return (cardId, why, code) => appendShiftEvent(bus, `${CARD_STOPPED} of card #${cardId}`, (db) => {
    const start = latestStartOf(db, cardId)
    return { type: CARD_STOPPED, cardId, pr: null, dedupeKey: `${CARD_STOPPED}:tree-pr:${start.dedupe_key}`, payload: { reason: 'fault', detail: `tree-pr: card #${cardId}: ${why}`, code } }
  })
}

export function busCardWaited(bus: PrOpenedBus): TreePrCliPorts['waited'] {
  return (cardId, wait) => appendShiftEvent(bus, `${CARD_STOPPED} of card #${cardId}`, (db) => {
    const start = latestStartOf(db, cardId)
    const scope = wait.widen.length === 0 ? {} : { widen: wait.widen, touches: wait.touches }
    return { type: CARD_STOPPED, cardId, pr: null, dedupeKey: `${CARD_STOPPED}:tree-pr:${start.dedupe_key}`, payload: { reason: QUESTION_AGENT, detail: `tree-pr: card #${cardId}: ${wait.detail}`, code: wait.code, ...scope } }
  })
}

export function busCardReturned(bus: PrOpenedBus): TreePrCliPorts['returned'] {
  return (cardId, code, why) => appendShiftEvent(bus, `${CARD_WAITING} of card #${cardId}`, (db) => {
    const start = latestStartOf(db, cardId)
    const returns = refusalCodesSince(db, cardId, start).length + 1
    return { type: CARD_WAITING, cardId, pr: null, dedupeKey: `${CARD_WAITING}:${RETURNED_TO_SESSION}:${start.dedupe_key}:${returns}`, payload: { reason: RETURNED_TO_SESSION, code, detail: `tree-pr: card #${cardId}: returned to its session: ${why}` } }
  })
}

export function busLastRefusal(busPath: string): TreePrCliPorts['lastRefusal'] {
  return (cardId) => {
    if (!existsSync(busPath))
      return null
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      const start = db.prepare(LATEST_START).get(cardId) as LatestStart | undefined
      return start === undefined ? null : refusalCodesSince(db, cardId, start)[0] ?? null
    }
    finally {
      db.close()
    }
  }
}

export function claudeResume(busPath: string): TreePrCliPorts['resume'] {
  return (cardId, worktree, prompt) => {
    if (!existsSync(busPath))
      return false
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    let session: string | undefined
    try {
      session = cardSessionOf(db, cardId)?.session
    }
    finally {
      db.close()
    }
    if (session === undefined)
      return false
    return spawnSync('claude', ['--permission-mode', CARD_PERMISSION_MODE, '-p', '--resume', session, prompt], { cwd: worktree, stdio: 'inherit' }).status === 0
  }
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
  waited: busCardWaited(REAL_BUS),
  lastRefusal: busLastRefusal(REAL_BUS.busPath),
  returned: busCardReturned(REAL_BUS),
  resume: claudeResume(REAL_BUS.busPath),
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
  const refuse = (why: string, reason: RefusalReason): number => {
    ports.stopped(cardId, why, refusalOf([{ reason, task: '', paths: [] }]).code)
    out(`${PREFIX}card #${cardId}: ${why}`)
    return 1
  }
  const text = ports.card(cardId)
  if (text === null)
    return refuse(`the bus holds no card body of card #${cardId} that parses; the tree is left uncommitted`, 'no-card-body')
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind === 'refused')
    return refuse(parsed.reason, 'card-unparsed')
  return settleTree(cardId, shiftTreeCard(parsed.parked.task), { worktree, report }, ports, out)
}

interface TreePlaces {
  worktree: string
  report: string | undefined
}

function reportOf(report: string | undefined): string | null {
  return report !== undefined && existsSync(report) ? readFileSync(report, 'utf8') : null
}

export function returnPrompt(cardId: number, why: string, refusal: Refusal, places: TreePlaces): string {
  return [
    `${PREFIX}card #${cardId}: ${why}.`,
    `The card returns to you once for ${refusal.code}. In ${places.worktree}, without changing the card's touches or its body:`,
    ...refusal.tasks.map(task => `- ${task}`),
    `Then repeat the card's witnesses, pnpm typecheck and pnpm lint, each as its own command, update the shift report${places.report === undefined ? '' : ` ${places.report}`}, and end the session: the shift checks the tree again and opens the pull request. The same refusal a second time is a wait for the window.`,
  ].join('\n')
}

function settleTree(cardId: number, card: TreeCard, places: TreePlaces, ports: TreePrCliPorts, out: (line: string) => void): number {
  for (;;) {
    const outcome = treePr(ports, card, places.worktree, reportOf(places.report))
    if (outcome.kind !== 'problem') {
      if (outcome.kind === 'pr')
        ports.opened(cardId, Number(outcome.number))
      out(outcomeLine(cardId, outcome))
      return 0
    }
    const refusal = refusalOf(outcome.gaps)
    const wait = (detail: string, widen: string[]): number => {
      ports.waited(cardId, { code: refusal.code, detail, widen, touches: card.touches })
      out(`${PREFIX}card #${cardId}: ${detail}`)
      return 1
    }
    if (refusal.class === 'c') {
      ports.stopped(cardId, outcome.why, refusal.code)
      out(`${PREFIX}card #${cardId}: ${outcome.why}`)
      return 1
    }
    if (refusal.class === 'b')
      return wait(`${outcome.why}; ${refusal.code} changes the card's contract, so the card waits for the window to amend its touches by ${refusal.paths.join(', ')}; the session leaves them unchanged`, refusal.paths)
    if (ports.lastRefusal(cardId) === refusal.code)
      return wait(`${outcome.why}; ${refusal.code} came back right after the card was returned to its session for it, so the card waits for the window`, [])
    ports.returned(cardId, refusal.code, outcome.why)
    out(`${PREFIX}card #${cardId}: returned to its session for ${refusal.code}: ${outcome.why}`)
    if (!ports.resume(cardId, places.worktree, returnPrompt(cardId, outcome.why, refusal, places)))
      return wait(`${outcome.why}; the session the card was returned to for ${refusal.code} did not run to its end, so the card waits for the window`, [])
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runTreePr(process.argv.slice(2))
