import type { DatabaseSync } from 'node:sqlite'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { RequestExecutor } from './context.js'
import type { Executed } from './request.js'
import { launchProcess, REAL_PROCESSES } from '../../nodes/restart/chain-process.js'
import { BusRead } from '../../ports/bus-read.js'
import { ownerMoveExecutor } from './owner-move.js'
import { appendedAndReduced, appendEvent, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED, CHILD_ENDED, CHILD_STARTED, inTransaction, OWNER, TASK_COMPLETED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_SUPERSEDED, WITHDRAWN } from './reach.js'
import { text } from './request.js'

export const OWNER_STOP_CODE = 'owner-stop'
const STOP_REASON = 'fault'
const CHILD_MODE = 'child'
const LEASE_ENDS = [TASK_COMPLETED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_SUPERSEDED] as const

interface StartedSession {
  session: string
  pgid: number
  worktree: string | null
}

interface HeldLease {
  taskKey: string
  queue: string
  cardId: number
  pr: number | null
  head: string | null
  leaseGen: number
  generation: string | null
  leasedAt: number
}

interface LeasedSession {
  lease: HeldLease
  pgid: number
  tree: string | null
}

interface StopAsked {
  db: DatabaseSync
  processes: ProcessTable
  cardId: number
  reason: string | null
  ts: string
}

function groupOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1 ? value : null
}

function startedSessionOf(db: DatabaseSync, cardId: number, start: number): StartedSession | null {
  const read = new BusRead(db).where({ card: cardId, from: start })
  const row = [...read.slice(CARD_STARTED, ['session', 'pgid', 'worktree']), ...read.slice(CARD_CONTINUED, ['session', 'pgid', 'worktree'])].find(event => event.id === start)
  if (row === undefined)
    return null
  const session = text(row.fields.session)
  const group = groupOf(row.fields.pgid)
  return session === null || group === null ? null : { session, pgid: group, worktree: text(row.fields.worktree) }
}

function stillHeld(db: DatabaseSync, lease: HeldLease): boolean {
  const read = new BusRead(db).where({ card: lease.cardId, from: lease.leasedAt + 1 })
  return !LEASE_ENDS.some(type => read.slice(type, ['task_key']).some(ended => ended.fields.task_key === lease.taskKey))
}

function heldLeasesOf(db: DatabaseSync, cardId: number): HeldLease[] {
  const seen = new Set<string>()
  const held: HeldLease[] = []
  for (const leased of new BusRead(db).where({ card: cardId }).slice(TASK_LEASED, ['task_key', 'queue', 'lease_gen', 'generation']).reverse()) {
    const [taskKey, queue, leaseGen] = [text(leased.fields.task_key), text(leased.fields.queue), leased.fields.lease_gen]
    if (taskKey === null || queue === null || typeof leaseGen !== 'number' || seen.has(taskKey))
      continue
    seen.add(taskKey)
    const lease: HeldLease = { taskKey, queue, cardId, pr: leased.pr, head: leased.head, leaseGen, generation: text(leased.fields.generation), leasedAt: leased.id }
    if (stillHeld(db, lease))
      held.push(lease)
  }
  return held
}

function withdrawn(ts: string, lease: HeldLease) {
  const generation = lease.generation === null ? {} : { generation: lease.generation }
  return { ts, type: TASK_FAILED, actor: OWNER, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${TASK_FAILED}:${lease.taskKey}:${lease.leaseGen}`, payload: { task_key: lease.taskKey, queue: lease.queue, ...generation, lease_gen: lease.leaseGen, reason: OWNER_STOP_CODE, next: WITHDRAWN, uncounted: true }, legacy: false }
}

function openChildOf(db: DatabaseSync, taskKey: string, leasedAt: number): { pgid: number, tree: string | null } | null {
  const read = new BusRead(db).where({ from: leasedAt })
  const ends = read.slice(CHILD_ENDED, ['pid', 'task_key']).filter(end => end.fields.task_key === taskKey)
  const open = read.slice(CHILD_STARTED, ['mode', 'pid', 'pgid', 'task_key', 'tree'])
    .filter(start => start.fields.task_key === taskKey && start.fields.mode === CHILD_MODE)
    .filter(start => !ends.some(end => end.id > start.id && end.fields.pid === start.fields.pid))
    .at(-1)
  const group = groupOf(open?.fields.pgid)
  return open === undefined || group === null ? null : { pgid: group, tree: text(open.fields.tree) }
}

function leasedSessionOf(db: DatabaseSync, cardId: number): LeasedSession | null {
  for (const lease of heldLeasesOf(db, cardId)) {
    const child = openChildOf(db, lease.taskKey, lease.leasedAt)
    if (child !== null)
      return { lease, ...child }
  }
  return null
}

function keptTree(tree: string | null): string {
  return `${tree === null ? 'its tree' : `its tree ${tree}`} and its uncommitted changes are kept`
}

function stopLaunchSession(asked: StopAsked, start: number): Executed {
  const { db, processes, cardId, reason, ts } = asked
  const later = `the launch node stops the session of card #${cardId} started at event ${start} on its next pass`
  if (reason === null)
    return { done: true, why: later }
  const started = startedSessionOf(db, cardId, start)
  if (started === null || launchProcess(started, processes) !== 'live')
    return { done: true, why: `${later}; the owner's reason: ${reason}` }
  processes.signalGroup(started.pgid)
  const detail = `${OWNER_STOP_CODE}: the owner stopped card #${cardId} session ${started.session} (process group ${started.pgid}): ${reason}; ${keptTree(started.worktree)}`
  appendEvent(db, { ts, type: CARD_STOPPED, actor: OWNER, cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${OWNER_STOP_CODE}:${start}`, payload: { reason: STOP_REASON, code: OWNER_STOP_CODE, stop_reason: reason, detail }, legacy: false })
  return { done: true, why: detail }
}

function stopLeasedSession(asked: StopAsked, held: LeasedSession): Executed {
  const { db, processes, cardId, reason, ts } = asked
  const { lease, pgid, tree } = held
  const running = processes.commandLine(pgid) !== null
  const said = reason === null ? '' : `: ${reason}`
  const signalled = running ? `process group ${pgid} signalled` : `process group ${pgid} had already ended`
  const detail = `${OWNER_STOP_CODE}: the owner stopped card #${cardId} ${lease.queue} session of task ${lease.taskKey} (${signalled})${said}; its lease is released; ${keptTree(tree)}`
  const stopped = { ts, type: CARD_STOPPED, actor: OWNER, cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_STOPPED}:${OWNER_STOP_CODE}:${lease.taskKey}:${lease.leaseGen}`, payload: { reason: STOP_REASON, code: OWNER_STOP_CODE, ...(reason === null ? {} : { stop_reason: reason }), detail }, legacy: false }
  const withdrew = inTransaction(db, () => {
    if (!stillHeld(db, lease))
      return false
    appendEvent(db, stopped)
    appendedAndReduced(db, withdrawn(ts, lease))
    return true
  })
  if (!withdrew)
    return { done: false, why: `card #${cardId} has no live session to stop: the lease of ${lease.taskKey} ended while the stop was read` }
  if (running)
    processes.signalGroup(pgid)
  return { done: true, why: detail }
}

export function ownerStopExecutor(processes: ProcessTable): RequestExecutor {
  return ownerMoveExecutor('owner.stop', ({ context, cardId, payload, ts }) => {
    const asked: StopAsked = { db: context.db, processes, cardId, reason: text(payload.reason), ts }
    const start = context.openSessionOf(cardId)
    if (start !== null)
      return stopLaunchSession(asked, start)
    const leased = leasedSessionOf(context.db, cardId)
    if (leased === null)
      return { done: false, why: `card #${cardId} has no live session to stop: the bus holds no session of it that started and has not ended, and no task lease of it with an executor that has not ended` }
    return stopLeasedSession(asked, leased)
  })
}

export const execute = ownerStopExecutor(REAL_PROCESSES)
