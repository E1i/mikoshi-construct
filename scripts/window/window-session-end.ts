import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { appendEvent } from '../core/db.js'
import { CARD_SESSION_ENDED, CARD_STARTED, PR_OPENED, WINDOW_HEARTBEAT } from '../core/events.js'
import { latestTurnOf } from '../core/queue.js'
import { STARTER_ACTOR } from './window-prs.js'

export const WINDOW_SESSION_END_ACTOR = 'worker:supervisor:window-session-end'
export const WINDOW_SESSION_SWEEP_MS = 60_000
const SESSION_ENDED_AFTER = `SELECT 1 FROM events WHERE card_id = ? AND legacy = 0 AND type = '${CARD_SESSION_ENDED}' AND id > ? LIMIT 1`
const PR_OPENED_AFTER = `SELECT 1 FROM events WHERE card_id = ? AND legacy = 0 AND type = '${PR_OPENED}' AND id > ? LIMIT 1`

export const SESSION_JOURNAL = '.construct/turns.jsonl'
const SESSION_END_LINE = 'session-end'

const STARTED_BY_A_WINDOW = `started.type = '${CARD_STARTED}' AND started.legacy = 0 AND started.actor LIKE '${STARTER_ACTOR}%' AND json_extract(started.payload, '$.shift') IS NULL AND json_extract(started.payload, '$.session') IS NOT NULL`

const WINDOW_START_WITH_ITS_PR = `SELECT 1 FROM events AS started WHERE started.id = ? AND ${STARTED_BY_A_WINDOW} AND EXISTS (SELECT 1 FROM prs WHERE prs.card_id = started.card_id)`

const UNENDED_WINDOW_STARTS = `
  SELECT started.card_id, started.ts, started.dedupe_key, json_extract(started.payload, '$.session') AS session, json_extract(started.payload, '$.worktree') AS worktree FROM events AS started
  LEFT JOIN cards ON cards.card_id = started.card_id
  WHERE ${STARTED_BY_A_WINDOW}
    AND started.id = (SELECT max(id) FROM events WHERE card_id = started.card_id AND type = '${CARD_STARTED}' AND legacy = 0)
    AND coalesce(cards.state, '') NOT IN ('${MERGED_CARD}', '${CLOSED_CARD}', '${DROPPED_CARD}')
    AND NOT EXISTS (SELECT 1 FROM events WHERE card_id = started.card_id AND id > started.id AND legacy = 0 AND type = '${CARD_SESSION_ENDED}')
  ORDER BY started.card_id
`

const PROJECT_ROOTS_OF_SESSION = `SELECT DISTINCT json_extract(payload, '$.root') AS root FROM events WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0 AND json_extract(payload, '$.session') = ? AND json_extract(payload, '$.root') IS NOT NULL`

const LAST_BEAT_OF_SESSION = `SELECT max(ts) AS ts FROM events WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0 AND json_extract(payload, '$.session') = ?`

const ENDED_WINDOW_TURN = `
  SELECT started.id, json_extract(started.payload, '$.session') AS session FROM events AS started
  WHERE started.id = ${latestTurnOf('?')} AND ${STARTED_BY_A_WINDOW}
    AND EXISTS (SELECT 1 FROM events WHERE card_id = started.card_id AND id > started.id AND legacy = 0 AND type = '${CARD_SESSION_ENDED}')
    AND NOT EXISTS (SELECT 1 FROM prs WHERE prs.card_id = started.card_id AND prs.state = 'open')
`

interface UnendedStart {
  card_id: number
  ts: string
  dedupe_key: string
  session: string
  worktree: string | null
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
    const starts = this.db.prepare(UNENDED_WINDOW_STARTS).all() as unknown as UnendedStart[]
    const journals = new Map<string, Map<string, string>>()
    return starts.flatMap((start) => {
      const end = this.provenEnd(start, journals)
      return end !== null && this.record(start, end, nowMs) ? [`${this.prefix}${CARD_SESSION_ENDED} #${start.card_id}: its window session ${start.session} ended at ${end}`] : []
    })
  }

  private provenEnd(start: UnendedStart, journals: Map<string, Map<string, string>>): string | null {
    const beats = this.db.prepare(PROJECT_ROOTS_OF_SESSION).all(start.session) as { root: string }[]
    const roots = [this.root, ...(start.worktree === null ? [] : [start.worktree]), ...beats.map(beat => beat.root)]
    const end = [...new Set(roots)].flatMap(root => this.endsIn(root, journals).get(start.session) ?? []).sort().at(-1)
    if (end === undefined || !endedAfter(start.ts, end))
      return null
    const lastBeat = (this.db.prepare(LAST_BEAT_OF_SESSION).get(start.session) as { ts: string | null }).ts
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

export function windowSessionEndGround(db: DatabaseSync, cardId: number): { named: string } | null {
  const turn = db.prepare(ENDED_WINDOW_TURN).get(cardId) as { id: number, session: string } | undefined
  return turn === undefined ? null : { named: `its window session ${turn.session} started at event ${turn.id} has ended and no pull request of the card is open` }
}

export function startStillOpen(db: DatabaseSync, cardId: number, startId: number): boolean {
  if (db.prepare(WINDOW_START_WITH_ITS_PR).get(startId) !== undefined)
    return false
  return [SESSION_ENDED_AFTER, PR_OPENED_AFTER].every(ended => db.prepare(ended).get(cardId, startId) === undefined)
}
