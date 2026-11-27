import type { DatabaseSync } from 'node:sqlite'
import type { EventRow } from '../core/events-query.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { cardsWithAState } from '../core/card-readings.js'
import { appendEvent } from '../core/db.js'
import { BY_CARD, byId, events, lastPer } from '../core/events-query.js'
import { CARD_SESSION_ENDED, CARD_STARTED, PR_OPENED, WINDOW_HEARTBEAT } from '../core/events.js'
import { ofCard as prsOfCard } from '../core/pr-readings.js'
import { latestTurnOf } from '../core/queue.js'
import { startedByTheWindow } from './window-prs.js'

export const WINDOW_SESSION_END_ACTOR = 'worker:supervisor:window-session-end'
export const WINDOW_SESSION_SWEEP_MS = 60_000

export const SESSION_JOURNAL = '.construct/turns.jsonl'
const SESSION_END_LINE = 'session-end'
const ENDED_CARDS = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])
const LATEST_TURN = `SELECT ${latestTurnOf('?')} AS id`
const OPEN_PR = 'open'

interface UnendedStart {
  card_id: number
  ts: string
  dedupe_key: string
  session: string
  worktree: string | null
}

interface WindowStart {
  row: EventRow
  session: string
}

function windowStartOf(row: EventRow | null): WindowStart | null {
  const session = row?.data?.session ?? null
  return row === null || row.type !== CARD_STARTED || row.legacy || session === null || !startedByTheWindow(row) ? null : { row, session: session as string }
}

function unendedWindowStarts(db: DatabaseSync): UnendedStart[] {
  const states = cardsWithAState(db)
  const ended = new Map(lastPer(db, BY_CARD, { types: [CARD_SESSION_ENDED] }).map(row => [row.card_id, row.id] as const))
  return lastPer(db, BY_CARD, { types: [CARD_STARTED], withCard: true }).flatMap((row) => {
    const start = windowStartOf(row)
    const card = row.card_id!
    if (start === null || row.ts === null || ENDED_CARDS.has(states.get(card) ?? '') || (ended.get(card) ?? 0) > row.id)
      return []
    const worktree = row.data?.worktree ?? null
    return [{ card_id: card, ts: row.ts, dedupe_key: row.dedupe_key, session: start.session, worktree: worktree === null ? null : worktree as string }]
  }).sort((a, b) => a.card_id - b.card_id)
}

interface SessionBeats {
  roots: string[]
  last: string | null
}

function beatsOfSession(db: DatabaseSync, session: string): SessionBeats {
  const beats = events(db, { types: [WINDOW_HEARTBEAT], mentions: session }).filter(beat => beat.data?.session === session)
  const roots = beats.flatMap(beat => beat.data?.root === undefined || beat.data.root === null ? [] : [beat.data.root as string])
  const last = beats.flatMap(beat => beat.ts === null ? [] : [beat.ts]).sort().at(-1) ?? null
  return { roots: [...new Set(roots)], last }
}

function endedAfterTheStart(db: DatabaseSync, cardId: number, startId: number, types: readonly string[]): boolean {
  return events(db, { card: cardId, types, since: startId, limit: 1 }).length > 0
}

function journalText(root: string): string {
  try {
    return readFileSync(path.join(root, SESSION_JOURNAL), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return ''
    throw error
  }
}

function journalLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

export function lastEndsOfSessions(journal: string): Map<string, string> {
  const ends = new Map<string, string>()
  for (const line of journal.split('\n').map(journalLine)) {
    if (line === null || typeof line.session !== 'string')
      continue
    if (line.kind === SESSION_END_LINE && typeof line.at === 'string')
      ends.set(line.session, line.at)
    else
      ends.delete(line.session)
  }
  return ends
}

function endedAfter(moment: string, end: string): boolean {
  return Date.parse(end) >= Date.parse(moment)
}

export class WindowSessionEnds {
  private lastSweep = Number.NEGATIVE_INFINITY

  constructor(private readonly db: DatabaseSync, private readonly root: string, private readonly now: () => number, private readonly prefix: string = '') {}

  step(): string[] {
    const nowMs = this.now()
    if (nowMs - this.lastSweep < WINDOW_SESSION_SWEEP_MS)
      return []
    this.lastSweep = nowMs
    try {
      return this.sweep(nowMs)
    }
    catch (error) {
      return [`${this.prefix}reading the ends of window sessions failed: ${error instanceof Error ? error.message : String(error)}; retried on the next sweep`]
    }
  }

  private sweep(nowMs: number): string[] {
    const starts = unendedWindowStarts(this.db)
    const journals = new Map<string, Map<string, string>>()
    return starts.flatMap((start) => {
      const end = this.provenEnd(start, journals)
      return end !== null && this.record(start, end, nowMs) ? [`${this.prefix}${CARD_SESSION_ENDED} #${start.card_id}: its window session ${start.session} ended at ${end}`] : []
    })
  }

  private provenEnd(start: UnendedStart, journals: Map<string, Map<string, string>>): string | null {
    const beats = beatsOfSession(this.db, start.session)
    const roots = [this.root, ...(start.worktree === null ? [] : [start.worktree]), ...beats.roots]
    const end = [...new Set(roots)].flatMap(root => this.endsIn(root, journals).get(start.session) ?? []).sort().at(-1)
    if (end === undefined || !endedAfter(start.ts, end))
      return null
    const lastBeat = beats.last
    return lastBeat !== null && Date.parse(lastBeat) > Date.parse(end) ? null : end
  }

  private endsIn(root: string, journals: Map<string, Map<string, string>>): Map<string, string> {
    const known = journals.get(root)
    if (known !== undefined)
      return known
    const read = lastEndsOfSessions(journalText(root))
    journals.set(root, read)
    return read
  }

  private record(start: UnendedStart, end: string, nowMs: number): boolean {
    const detail = `card #${start.card_id} window session ${start.session} recorded its own end at ${end}`
    return appendEvent(this.db, { ts: new Date(nowMs).toISOString(), type: CARD_SESSION_ENDED, actor: WINDOW_SESSION_END_ACTOR, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${start.dedupe_key}`, payload: { session: start.session, stopped: false, detail }, legacy: false })
  }
}

function latestTurn(db: DatabaseSync, cardId: number): EventRow | null {
  const id = (db.prepare(LATEST_TURN).get(cardId) as { id: number | null }).id
  return id === null ? null : byId(db, Number(id))
}

export function windowSessionEndGround(db: DatabaseSync, cardId: number): { named: string } | null {
  const start = windowStartOf(latestTurn(db, cardId))
  if (start === null || !endedAfterTheStart(db, start.row.card_id!, start.row.id, [CARD_SESSION_ENDED]) || prsOfCard(db, start.row.card_id!).some(pr => pr.state === OPEN_PR))
    return null
  return { named: `its window session ${start.session} started at event ${start.row.id} has ended and no pull request of the card is open` }
}

export function startStillOpen(db: DatabaseSync, cardId: number, startId: number): boolean {
  const start = windowStartOf(byId(db, startId))
  if (start !== null && start.row.card_id !== null && prsOfCard(db, start.row.card_id).length > 0)
    return false
  return !endedAfterTheStart(db, cardId, startId, [CARD_SESSION_ENDED, PR_OPENED])
}
