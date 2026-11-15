import type { DatabaseSync } from 'node:sqlite'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { RequestExecutor } from './context.js'
import { launchProcess, REAL_PROCESSES } from '../../nodes/restart/chain-process.js'
import { ownerMoveExecutor } from './owner-move.js'
import { appendEvent, CARD_STOPPED, OWNER } from './reach.js'
import { text } from './request.js'

export const OWNER_STOP_CODE = 'owner-stop'
const STOP_REASON = 'fault'
const STARTED_SESSION = `SELECT json_extract(payload, '$.session') AS session, json_extract(payload, '$.pgid') AS pgid, json_extract(payload, '$.worktree') AS worktree, dedupe_key FROM events WHERE id = ? AND json_valid(payload)`

interface StartedSession {
  session: string
  pgid: number
  worktree: string | null
  dedupeKey: string
}

function startedSessionOf(db: DatabaseSync, start: number): StartedSession | null {
  const row = db.prepare(STARTED_SESSION).get(start) as { session: unknown, pgid: unknown, worktree: unknown, dedupe_key: string | null } | undefined
  if (row === undefined || row.dedupe_key === null)
    return null
  const session = text(row.session)
  const pgid = typeof row.pgid === 'number' && Number.isSafeInteger(row.pgid) && row.pgid > 1 ? row.pgid : null
  return session === null || pgid === null ? null : { session, pgid, worktree: text(row.worktree), dedupeKey: row.dedupe_key }
}

export function ownerStopExecutor(processes: ProcessTable): RequestExecutor {
  return ownerMoveExecutor('owner.stop', ({ context, cardId, payload, ts }) => {
    const start = context.openSessionOf(cardId)
    if (start === null)
      return { done: false, why: `card #${cardId} has no live session to stop: the bus holds no session of it that started and has not ended` }
    const reason = text(payload.reason)
    const later = `the launch node stops the session of card #${cardId} started at event ${start} on its next pass`
    if (reason === null)
      return { done: true, why: later }
    const started = startedSessionOf(context.db, start)
    if (started === null || launchProcess(started, processes) !== 'live')
      return { done: true, why: `${later}; the owner's reason: ${reason}` }
    processes.signalGroup(started.pgid)
    const tree = started.worktree === null ? 'its tree' : `its tree ${started.worktree}`
    const detail = `${OWNER_STOP_CODE}: the owner stopped card #${cardId} session ${started.session} (process group ${started.pgid}): ${reason}; ${tree} and its uncommitted changes are kept`
    appendEvent(context.db, { ts, type: CARD_STOPPED, actor: OWNER, cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${OWNER_STOP_CODE}:${started.dedupeKey}`, payload: { reason: STOP_REASON, code: OWNER_STOP_CODE, stop_reason: reason, detail }, legacy: false })
    return { done: true, why: detail }
  })
}

export const execute = ownerStopExecutor(REAL_PROCESSES)
