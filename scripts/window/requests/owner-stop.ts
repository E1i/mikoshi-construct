import type { DatabaseSync } from 'node:sqlite'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { RequestExecutor } from './context.js'
import { launchProcess, REAL_PROCESSES } from '../../nodes/restart/chain-process.js'
import { BusRead } from '../../ports/bus-read.js'
import { ownerMoveExecutor } from './owner-move.js'
import { appendEvent, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED, OWNER } from './reach.js'
import { text } from './request.js'

export const OWNER_STOP_CODE = 'owner-stop'
const STOP_REASON = 'fault'

interface StartedSession {
  session: string
  pgid: number
  worktree: string | null
}

function startedSessionOf(db: DatabaseSync, cardId: number, start: number): StartedSession | null {
  const read = new BusRead(db).where({ card: cardId, from: start })
  const row = [...read.slice(CARD_STARTED, ['session', 'pgid', 'worktree']), ...read.slice(CARD_CONTINUED, ['session', 'pgid', 'worktree'])].find(event => event.id === start)
  if (row === undefined)
    return null
  const session = text(row.fields.session)
  const { pgid } = row.fields
  const group = typeof pgid === 'number' && Number.isSafeInteger(pgid) && pgid > 1 ? pgid : null
  return session === null || group === null ? null : { session, pgid: group, worktree: text(row.fields.worktree) }
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
    const started = startedSessionOf(context.db, cardId, start)
    if (started === null || launchProcess(started, processes) !== 'live')
      return { done: true, why: `${later}; the owner's reason: ${reason}` }
    processes.signalGroup(started.pgid)
    const tree = started.worktree === null ? 'its tree' : `its tree ${started.worktree}`
    const detail = `${OWNER_STOP_CODE}: the owner stopped card #${cardId} session ${started.session} (process group ${started.pgid}): ${reason}; ${tree} and its uncommitted changes are kept`
    appendEvent(context.db, { ts, type: CARD_STOPPED, actor: OWNER, cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${OWNER_STOP_CODE}:${start}`, payload: { reason: STOP_REASON, code: OWNER_STOP_CODE, stop_reason: reason, detail }, legacy: false })
    return { done: true, why: detail }
  })
}

export const execute = ownerStopExecutor(REAL_PROCESSES)
