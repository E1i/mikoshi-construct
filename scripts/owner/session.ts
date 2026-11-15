import type { DatabaseSync } from 'node:sqlite'
import type { TranscriptReader, TranscriptReading } from '../../src/commands/board/sessions.js'
import type { ActionOf } from '../supervisor/expected-time.js'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { actionName, clientTranscriptReader, clockOf, longGaps, readTranscript, runningAction, SHOWN_ACTIONS } from '../../src/commands/board/sessions.js'
import { withReadOnlyBus } from '../../src/commands/cost/bus.js'
import { defaultBusPath } from '../core/db.js'
import { CARD_STARTED, SESSION_HEARTBEAT } from '../core/events.js'
import { coverageLines, roundSamples } from '../supervisor/expected-time.js'

export const PREFIX = '[owner:session] '
export const USAGE = 'usage: owner:session <#card> | owner:session --coverage'
const COVERAGE_FLAG = '--coverage'
const A_CARD = /^#?(\d+)$/
const MINUTE_MS = 60_000

export interface CardSession {
  card: number
  session: string
  worktree: string | null
  startedAt: string
  lastBeat: string
}

const LAST_SESSION_BEAT = `
  SELECT ts, json_extract(payload, '$.session') AS session FROM events
  WHERE type = '${SESSION_HEARTBEAT}' AND legacy = 0 AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.session') = 'text'
  ORDER BY id DESC LIMIT 1
`

const FIRST_SESSION_BEAT = `
  SELECT min(ts) AS ts FROM events
  WHERE type = '${SESSION_HEARTBEAT}' AND legacy = 0 AND card_id = ? AND json_valid(payload) AND json_extract(payload, '$.session') = ?
`

const LAST_START = `
  SELECT ts, json_extract(payload, '$.session') AS session, json_extract(payload, '$.worktree') AS worktree FROM events
  WHERE type = '${CARD_STARTED}' AND legacy = 0 AND card_id = ? AND json_valid(payload)
  ORDER BY id DESC LIMIT 1
`

export function cardSessionOf(db: DatabaseSync, card: number): CardSession | null {
  const beat = db.prepare(LAST_SESSION_BEAT).get(card) as { ts: string, session: string } | undefined
  const start = db.prepare(LAST_START).get(card) as { ts: string, session: unknown, worktree: unknown } | undefined
  const worktree = typeof start?.worktree === 'string' ? start.worktree : null
  if (beat !== undefined) {
    const first = (db.prepare(FIRST_SESSION_BEAT).get(card, beat.session) as { ts: string | null }).ts ?? beat.ts
    const startedAt = start !== undefined && start.session === beat.session && start.ts < first ? start.ts : first
    return { card, session: beat.session, worktree, startedAt, lastBeat: beat.ts }
  }
  if (start === undefined || typeof start.session !== 'string')
    return null
  return { card, session: start.session, worktree, startedAt: start.ts, lastBeat: start.ts }
}

function minutes(from: string, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - Date.parse(from)) / MINUTE_MS))
}

function ranFor(action: { at: string, endedAt: string | null }, now: Date): string {
  const end = action.endedAt === null ? now : new Date(action.endedAt)
  return action.endedAt === null ? `running ${minutes(action.at, end)} min` : `ran ${minutes(action.at, end)} min`
}

const CARD_TREE = `
  SELECT json_extract(payload, '$.worktree') AS worktree FROM events
  WHERE legacy = 0 AND type = '${CARD_STARTED}' AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.worktree') = 'text'
  ORDER BY id DESC LIMIT 1
`

export function actionInCardTree(db: DatabaseSync, clock: () => Date, read: TranscriptReader = clientTranscriptReader): ActionOf {
  return (cardId, session) => {
    const tree = (db.prepare(CARD_TREE).get(cardId) as { worktree: string } | undefined)?.worktree
    const transcript = tree === undefined || session === null ? null : read(tree, session)
    return transcript === null ? null : nowLine(readTranscript(transcript), clock())
  }
}

function nowLine(reading: TranscriptReading, now: Date): string {
  const running = runningAction(reading)
  if (running !== null)
    return `now: ${actionName(running)}, running for ${minutes(running.at, now)} min`
  const last = reading.stamps.at(-1)
  return last === undefined ? 'now: the transcript holds no line yet' : `now: no tool running; the last transcript line is from ${clockOf(last)}, ${minutes(last, now)} min ago, and nothing says why it waits`
}

export function sessionViewLines(found: CardSession, transcript: string | null, now: Date): string[] {
  const head = [
    `${PREFIX}card #${found.card} session ${found.session}${found.worktree === null ? '' : ` in ${found.worktree}`}`,
    `${PREFIX}started ${clockOf(found.startedAt)}, ${minutes(found.startedAt, now)} min ago · last heartbeat ${minutes(found.lastBeat, now)} min ago`,
  ]
  if (transcript === null)
    return [...head, `${PREFIX}no transcript of session ${found.session} was found${found.worktree === null ? ': the bus recorded no tree for the card' : ` for the tree ${found.worktree}`}`]
  const reading = readTranscript(transcript)
  const actions = reading.actions.slice(-SHOWN_ACTIONS).map(action => `${PREFIX}  ${clockOf(action.at)}  ${actionName(action)} (${ranFor(action, now)})`)
  const gaps = longGaps(reading, now, true).map(gap => `${PREFIX}  ${clockOf(gap.from)} → ${clockOf(gap.to)}  ${gap.minutes} min${gap.after === null ? ' before any tool ran' : ` after ${gap.after}`}`)
  return [
    ...head,
    `${PREFIX}${nowLine(reading, now)}`,
    `${PREFIX}last actions:${actions.length === 0 ? ' none' : ''}`,
    ...actions,
    `${PREFIX}long gaps:${gaps.length === 0 ? ' none' : ''}`,
    ...gaps,
  ]
}

export function runOwnerSession(args: readonly string[], db: DatabaseSync, read: TranscriptReader, now: Date, out: (line: string) => void): number {
  if (args.length === 1 && args[0] === COVERAGE_FLAG) {
    for (const line of coverageLines(roundSamples(db)))
      out(`${PREFIX}${line}`)
    return 0
  }
  const card = args.length === 1 ? A_CARD.exec(args[0]!) : null
  if (card === null) {
    out(`${PREFIX}${USAGE}`)
    return 2
  }
  const found = cardSessionOf(db, Number(card[1]))
  if (found === null) {
    out(`${PREFIX}card #${card[1]} has no session the bus recorded: no heartbeat and no start names one`)
    return 1
  }
  for (const line of sessionViewLines(found, found.worktree === null ? null : read(found.worktree, found.session), now))
    out(line)
  return 0
}

function main(): number {
  const file = defaultBusPath()
  if (!existsSync(file)) {
    console.log(`${PREFIX}no bus at ${file}`)
    return 1
  }
  return withReadOnlyBus(file, db => runOwnerSession(process.argv.slice(2), db, clientTranscriptReader, new Date(), line => console.log(line)))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
