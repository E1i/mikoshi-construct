import type { DatabaseSync } from 'node:sqlite'
import type { TranscriptReader } from '../../src/commands/board/sessions.js'
import type { CardSession } from './expected-time.js'
import { existsSync } from 'node:fs'
import { actionName, clientTranscriptReader, clockOf, longGaps, minutesBetween, nowLine, readTranscript, SHOWN_ACTIONS } from '../../src/commands/board/sessions.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { openDatabase } from '../core/sqlite.js'
import { cardSessionOf, coverageLines, roundSamples } from './expected-time.js'

export function transcriptActionIn(read: TranscriptReader = clientTranscriptReader): (tree: string, session: string, now: Date) => string | null {
  return (tree, session, now) => {
    const transcript = read(tree, session)
    return transcript === null ? null : nowLine(readTranscript(transcript), now)
  }
}

export const PREFIX = '[owner:session] '
export const USAGE = 'usage: owner:session <#card> | owner:session --coverage'
const A_CARD = /^#?(\d+)$/

function ranFor(action: { at: string, endedAt: string | null }, now: Date): string {
  return action.endedAt === null ? `running ${minutesBetween(action.at, now.toISOString())} min` : `ran ${minutesBetween(action.at, action.endedAt)} min`
}

export function sessionViewLines(found: CardSession, transcript: string | null, now: Date): string[] {
  const at = now.toISOString()
  const head = [
    `${PREFIX}card #${found.card} session ${found.session}${found.worktree === null ? '' : ` in ${found.worktree}`}`,
    `${PREFIX}started ${clockOf(found.startedAt)}, ${minutesBetween(found.startedAt, at)} min ago · last heartbeat ${minutesBetween(found.lastBeat, at)} min ago`,
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

export interface OwnerSessionAsk {
  args: readonly string[]
  coverageFlag: string
}

export function runOwnerSession({ args, coverageFlag }: OwnerSessionAsk, db: DatabaseSync, read: TranscriptReader, now: Date, out: (line: string) => void): number {
  if (args.length === 1 && args[0] === coverageFlag) {
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

export function ownerSessionMain(ask: OwnerSessionAsk, out: (line: string) => void): number {
  const file = defaultBusPath()
  if (!existsSync(file)) {
    out(`${PREFIX}no bus at ${file}`)
    return 1
  }
  const db = openDatabase(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return runOwnerSession(ask, db, clientTranscriptReader, new Date(), out)
  }
  finally {
    db.close()
  }
}
