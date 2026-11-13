import type { DatabaseSync } from 'node:sqlite'
import type { SessionStop, SessionStopCode } from '../../core/card-hold.js'
import type { BusEvent } from '../../core/db.js'
import type { Lease } from '../../core/lease.js'
import type { MachineClaimant, MachineSessions } from '../../core/machine-sessions.js'
import type { DetectionMode, NodeDeclaration, NodeParts, WaitStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { DiskReader } from '../../ports/disk.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { ProcessTable } from '../restart/chain-process.js'
import type { Contour } from './launch-candidates.js'
import type { CardStarter, LaunchOutcome, StartedCard } from './launch-executor.js'
import type { SessionContinuer } from './launch-starter.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseParkingFile } from '../../../src/card/parking.js'
import { NOT_A_BACKFILL } from '../../core/backfill-source.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD, RUNNING_CARD } from '../../core/card-automaton.js'
import { admittedBodies, admittedBodyText, bodyNotFoldedYet, pathsOutsideTheBody } from '../../core/card-bodies.js'
import { cardHoldOf, HOLD_RECHECK_MS, SESSION_STOP_CODES, sessionStopOf } from '../../core/card-hold.js'
import { appendEvent, inTransaction, openOwnerWait } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_CLOSED, CARD_CONTINUED, CARD_HELD, CARD_PULSE, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, CARD_WAITING, COMMAND_EXECUTED, DECISION_RECORDED, GHOST_ROW, LADDER_APPROVAL, MERGE_DONE, OPEN_QUESTION, OUTSIDE_TOUCHES, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_CLOSED, PR_OBSERVED, PR_OPENED, QUESTION_AGENT, REDUCED, TASK_COMPLETED, TASK_ENQUEUED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_REQUEUED, TASK_SUPERSEDED } from '../../core/events.js'
import { generationOfKey } from '../../core/identifiers.js'
import { failTask } from '../../core/lease.js'
import { busNameOfDb, MACHINE_POLL_MS, machineSessions } from '../../core/machine-sessions.js'
import { Node, prefixOf, UNDERSTOOD_NOW } from '../../core/node.js'
import { MACHINE_OVERLOADED, machineOverloadedLine, timeoutUnderLoadOutside } from '../../core/observations.js'
import { ownerMoveCommand } from '../../core/owner-commands.js'
import { COMPLETED, generationField, LAUNCH_STOP_WITH_NO_PULL_REQUEST, launchTasks, LEASED, TASK_FOLDS } from '../../core/queue.js'
import { storedByKey } from '../../core/stored.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { BusRead } from '../../ports/bus-read.js'
import { clientTranscript } from '../../ports/client/claude/adapter.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { lacksItsPackages } from '../../ports/prepare-tree.js'
import { storedInput } from '../../ports/prompt-store.js'
import { launchDirOf } from '../../ports/tree-publish.js'
import { isAlive } from '../../quality/lock.js'
import { lastHeartbeat } from '../../supervisor/heartbeat.js'
import { launchProcess, REAL_PROCESSES } from '../restart/chain-process.js'
import { MAX_RESTARTS, reportedQuestions, reportedStopReason } from './continuation.js'
import { laneOverlapRecorder, layLanes, repositoryLanes } from './lane-assign.js'
import { holdReason, startHold, waitHeldAtTheExit } from './launch-candidates.js'
import { LaunchExecutor } from './launch-executor.js'
import { REPORT_MISSING, USAGE_LIMIT, usageLimitDetail, usageLimitResetIn, usageLimitResetOf } from './report-collect.js'
import { reportClosingOf } from './tree-pr.js'

export { launchDirOf }

export const LAUNCH_LIMIT_MINUTES = 600

const LAUNCH_LIMIT_MS = LAUNCH_LIMIT_MINUTES * 60_000

export const HEARTBEAT_SILENCE_MINUTES = 20

const HEARTBEAT_SILENCE_MS = HEARTBEAT_SILENCE_MINUTES * 60_000

const LEGACY_MERGE = 'merge'

export type PidAlive = (pid: number) => boolean

function recordedPidLivesIn(pid: number, pidAlive: PidAlive): boolean {
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid)
}

function ownerMovedSince(db: DatabaseSync, cardId: number, move: 'stop' | 'launch', since?: number): boolean {
  const ofTheCard = new BusRead(db).where({ card: cardId })
  return ofTheCard.where({ from: (since ?? ofTheCard.slice(CARD_STARTED, ['session'], 'last')[0]?.id ?? 0) + 1 }).slice(COMMAND_EXECUTED, ['command']).some(moved => moved.fields.command === ownerMoveCommand(move, cardId))
}

const LEGACY_PATH = 'path'
export const LAUNCH_ON = [CARD_ADMITTED, CARD_STARTED, CARD_CLOSED, CARD_STOPPED, PR_CLOSED, PR_OBSERVED, PR_OPENED, LEGACY_MERGE, LEGACY_PATH, TASK_ENQUEUED, TASK_REQUEUED, TASK_COMPLETED, TASK_FAILED, TASK_SUPERSEDED, TASK_RELEASED, TASK_EXPIRED, MERGE_DONE, GHOST_ROW, REDUCED] as const
export const LAUNCH_NODE: NodeDeclaration = { kind: 'launch', on: LAUNCH_ON, understands: UNDERSTOOD_NOW }

export type LaunchStep = LaunchOutcome | WaitStep

export const BODY_NOT_FOLDED = 'body_not_folded'

export interface LaunchNodeParts extends Pick<NodeParts, 'silentMs'> {
  db: DatabaseSync
  starter: CardStarter
  ladder?: CardStarter
  clock: () => Date
  disk?: DiskReader
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  processes?: ProcessTable
  pidAlive?: PidAlive
  resulted?: (card: StartedCard, start: SessionStart) => boolean
  endedWith?: (start: SessionStart) => string | null
  handedOff?: (start: SessionStart) => boolean
  reportOf?: (start: SessionStart) => string | null
  collected?: (card: StartedCard, start: SessionStart) => string | null
  usageLimitedUntil?: (card: StartedCard) => string | null
  warned?: (card: StartedCard) => boolean
  atContextLine?: (card: StartedCard) => boolean
  spendStopped?: (card: StartedCard) => boolean
  buildHandoff?: (card: StartedCard, start: SessionStart, body: string | null) => void
  publish?: (card: StartedCard, start: SessionStart) => void
  committed?: (card: StartedCard) => boolean
  continuer?: SessionContinuer
  isolation: IsolationReader
  prompts?: string
  lanes?: () => number
  machine?: MachineSessions
}

export interface SessionStart {
  cardId: number
  ts: string
}

interface RunningStart {
  id: number
  card_id: number
  ts: string
  dedupe_key: string
  payload: string
  state: string
}

const SESSION_STARTS = `'${CARD_STARTED}', '${CARD_CONTINUED}'`

function latestStartsOf(where: string, condition = ''): string {
  return `
  SELECT e.id, e.card_id, e.ts, e.dedupe_key, e.payload, c.state FROM cards AS c
  JOIN events AS e ON e.card_id = c.card_id AND e.type IN (${SESSION_STARTS}) AND e.legacy = 0
    AND e.id = (SELECT MAX(id) FROM events WHERE card_id = c.card_id AND type IN (${SESSION_STARTS}) AND legacy = 0)
  WHERE ${where}${condition}
  ORDER BY c.card_id
`
}

const RUNNING_STARTS = latestStartsOf(`c.state = '${RUNNING_CARD}'`)

const OUT_OF_RUNNING_STARTS = latestStartsOf(`c.state NOT IN ('${RUNNING_CARD}', '${MERGED_CARD}', '${CLOSED_CARD}')`, `
    AND NOT EXISTS (SELECT 1 FROM events WHERE card_id = c.card_id AND id > e.id AND legacy = 0 AND type IN ('${CARD_STOPPED}', '${CARD_SESSION_ENDED}'))`)

export const LAUNCH_START_MINUTES = 10

const LAUNCH_START_MS = LAUNCH_START_MINUTES * 60_000

export const LAUNCH_UNSTARTED = 'launch_unstarted'

const UNSTARTED_LAUNCH_LEASES = `
  SELECT tasks.task_key, tasks.card_id, tasks.lease_gen, leased.ts AS leased_at FROM tasks
  JOIN events AS leased ON leased.dedupe_key = '${TASK_LEASED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.queue = 'launch' AND tasks.state = '${LEASED}'
    AND NOT EXISTS (SELECT 1 FROM events WHERE card_id = tasks.card_id AND id > leased.id AND legacy = 0 AND type IN (${SESSION_STARTS}))
  ORDER BY tasks.id
`

interface UnstartedLease {
  task_key: string
  card_id: number
  lease_gen: number
  leased_at: string
}

const LAUNCH_TASK_OF_CARD = `SELECT task_key, state, event_id FROM tasks WHERE queue = 'launch' AND card_id = ? ORDER BY id DESC LIMIT 1`

interface LaunchTaskRow {
  task_key: string
  state: string
  event_id: number
}

const STOPPED_SINCE = `SELECT 1 FROM events WHERE type = '${CARD_STOPPED}' AND legacy = 0 AND card_id = ? AND id > ? LIMIT 1`

export const SESSION_DEATH_CAP = 3

const SESSION_DEATHS = `SELECT count(*) AS n FROM events WHERE type = '${CARD_STOPPED}' AND legacy = 0 AND card_id = ? AND dedupe_key LIKE '${CARD_STOPPED}:session-end:%'`

const USAGE_LIMIT_WAIT_PREFIX = `${CARD_WAITING}:${USAGE_LIMIT}:`

const CONTINUATIONS = `SELECT count(*) AS n FROM events AS c WHERE c.type = '${CARD_CONTINUED}' AND c.legacy = 0 AND c.card_id = ?
  AND c.id > (SELECT coalesce(MAX(id), 0) FROM events WHERE type = '${CARD_STARTED}' AND legacy = 0 AND card_id = ?)
  AND NOT EXISTS (SELECT 1 FROM events AS w WHERE w.type = '${CARD_WAITING}' AND w.card_id = c.card_id
    AND w.dedupe_key = '${USAGE_LIMIT_WAIT_PREFIX}' || substr(c.dedupe_key, ${CARD_CONTINUED.length + 2}))`

const USAGE_LIMIT_WAIT_OF_START = `SELECT payload FROM events WHERE type = '${CARD_WAITING}' AND card_id = ? AND dedupe_key = ? LIMIT 1`

const LATEST_USAGE_LIMIT_WAIT = `SELECT payload FROM events WHERE type = '${CARD_WAITING}' AND legacy = 0 AND dedupe_key LIKE '${USAGE_LIMIT_WAIT_PREFIX}%' ORDER BY id DESC LIMIT 1`

const PR_SINCE = `SELECT 1 FROM events WHERE card_id = ? AND id > ? AND type IN ('${PR_OPENED}', '${PR_OBSERVED}') LIMIT 1`

const GHOST_ROW_SINCE = `SELECT 1 FROM events WHERE type = '${GHOST_ROW}' AND card_id = ? AND id > ? LIMIT 1`

const VERIFIED_SINCE = `SELECT 1 FROM events WHERE type = '${CARD_VERIFIED}' AND legacy = 0 AND card_id = ? AND id > ? LIMIT 1`

export const PULSE_MINUTES = 5

const PULSE_MS = PULSE_MINUTES * 60_000

const LAST_PULSE = `SELECT ts FROM events WHERE type = '${CARD_PULSE}' AND legacy = 0 AND card_id = ? AND id > ? ORDER BY id DESC LIMIT 1`

export const SESSIONLESS_LADDER_STEP = 'launch'

export function noPullRequestDetail(cardId: number, session: string, result: string | null): string {
  return `session-end: card #${cardId} session ${session} ended with no pull request; ${result ?? 'its shift report names no result'}`
}

export const NOT_A_REPOSITORY_PATH = 'not a repository path, dropped from the widen'

export interface AskedPaths {
  widen: string[]
  dropped: string[]
}

export function isRepositoryPath(worktree: string, file: string): boolean {
  const root = path.resolve(worktree)
  const resolved = path.resolve(root, file)
  return resolved.startsWith(`${root}${path.sep}`) && existsSync(resolved)
}

export function splitByRepository(worktree: string, asked: readonly string[]): AskedPaths {
  return { widen: asked.filter(file => isRepositoryPath(worktree, file)), dropped: asked.filter(file => !isRepositoryPath(worktree, file)) }
}

export interface HeldSessionStop {
  code: SessionStopCode
  stop: number
  paths: string[]
}

function stopCodeOf(value: unknown): SessionStopCode | null {
  return SESSION_STOP_CODES.find(code => code === value) ?? null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []
}

function decidedOnTheCardSince(bus: BusRead, cardId: number, stop: number): boolean {
  return bus.where({ from: stop + 1 }).slice(DECISION_RECORDED, ['scope']).some(decided => Array.isArray(decided.fields.scope) && decided.fields.scope.includes(cardId))
}

const WAITS_OF_THE_CARD = 'SELECT id FROM owner_waits WHERE card_id = ?'

function aWaitOfTheCardClosedSince(db: DatabaseSync, bus: BusRead, cardId: number, stop: number): boolean {
  const ofTheCard = new Set((db.prepare(WAITS_OF_THE_CARD).all(cardId) as { id: string }[]).map(wait => wait.id))
  return bus.where({ from: stop + 1 }).slice(OWNER_WAIT_CLOSED, ['id']).some(closed => ofTheCard.has(String(closed.fields.id)))
}

function ownerAnsweredSince(db: DatabaseSync, bus: BusRead, cardId: number, stop: number): boolean {
  return decidedOnTheCardSince(bus, cardId, stop) || aWaitOfTheCardClosedSince(db, bus, cardId, stop)
}

function questionStillOpen(bus: BusRead, cardId: number, stop: number): boolean {
  if (decidedOnTheCardSince(bus, cardId, stop))
    return false
  const since = bus.where({ from: stop + 1 })
  const closed = new Set(since.slice(OWNER_WAIT_CLOSED, ['id']).map(each => each.fields.id))
  return since.where({ card: cardId }).slice(OWNER_WAIT_OPENED, ['id']).some(opened => !closed.has(opened.fields.id))
}

export function heldSessionStop(db: DatabaseSync, cardId: number): HeldSessionStop | null {
  const bus = new BusRead(db)
  const latest = bus.where({ card: cardId }).slice(CARD_STOPPED, ['code', 'paths'], 'last')[0]
  const stopCode = stopCodeOf(latest?.fields.code)
  if (latest === undefined || stopCode === null)
    return null
  const named = strings(latest.fields.paths)
  if (stopCode === OUTSIDE_TOUCHES) {
    const uncovered = pathsOutsideTheBody(db, cardId, named.join('\n'))
    return uncovered.length === 0 || ownerAnsweredSince(db, bus, cardId, latest.id) ? null : { code: stopCode, stop: latest.id, paths: uncovered }
  }
  return questionStillOpen(bus, cardId, latest.id) ? { code: stopCode, stop: latest.id, paths: named } : null
}

export function heldStopLine(cardId: number, held: HeldSessionStop): string {
  const why = held.code === OUTSIDE_TOUCHES ? `its touches still miss ${held.paths.join(', ')}, so it waits for intake to widen them, or for a decision bound to the card or the owner's word closing its wait that no widening is needed` : 'the question it stopped on is still open, so it waits for the decision or the owner wait to close'
  return `${held.code}: card #${cardId} is not launched again since stop ${held.stop}: ${why}`
}

const LATEST_ADMISSION = `SELECT payload FROM events WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND card_id = ? AND ${NOT_A_BACKFILL} ORDER BY id DESC LIMIT 1`

export const AMENDED_AFTER_START = 'amended-after-start'

export const WITHDRAWN_TO_CHEAP = 'withdrawn-to-cheap'

interface BodyAmendRow {
  started_text: string
  amended_text: string
}

interface BodyAmend {
  started: string
  amended: string
}

const HEADER_PRIORITY = /^priority:/

function withoutHeaderPriority(text: string): string {
  const lines = text.split('\n')
  const blank = lines.findIndex(line => line.trim() === '')
  const headerEnd = blank === -1 ? lines.length : blank
  return lines.filter((line, index) => index >= headerEnd || !HEADER_PRIORITY.test(line.trim())).join('\n')
}

function onlyThePriorityMoved(row: BodyAmendRow): boolean {
  return withoutHeaderPriority(row.started_text) === withoutHeaderPriority(row.amended_text)
}

function shortSha(sha: string): string {
  return sha.slice(0, 12)
}

function startedCardOf(payload: string): StartedCard | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const { session, worktree, branch, base, pid, pgid, contour, step } = parsed
    if (typeof session !== 'string' || typeof worktree !== 'string' || typeof branch !== 'string' || typeof base !== 'string' || typeof pid !== 'number' || typeof pgid !== 'number')
      return null
    if (contour !== 'cheap' && contour !== 'ladder')
      return null
    return { session, worktree, branch, base, pid, pgid, contour, ...(typeof step === 'string' ? { step } : {}) }
  }
  catch {
    return null
  }
}

export class LaunchNode extends Node<LaunchStep> {
  private readonly executor: LaunchExecutor
  private readonly starters: Partial<Record<Contour, CardStarter>>
  private readonly processes: ProcessTable
  private readonly pidAlive: PidAlive
  private readonly lanes: () => number
  private readonly machine: MachineSessions
  private readonly usageLimitedUntil: (card: StartedCard) => string | null

  constructor(private readonly launchParts: LaunchNodeParts) {
    super('launch', { db: launchParts.db, clock: launchParts.clock, session: launchParts.session, mode: launchParts.mode, env: launchParts.env, silentMs: launchParts.silentMs })
    this.executor = new LaunchExecutor(launchParts)
    this.starters = { cheap: launchParts.starter, ladder: launchParts.ladder }
    this.processes = launchParts.processes ?? REAL_PROCESSES
    this.pidAlive = launchParts.pidAlive ?? (launchParts.processes === undefined ? isAlive : () => true)
    this.lanes = launchParts.lanes ?? repositoryLanes(process.cwd())
    this.machine = launchParts.machine ?? machineSessions(isAlive)
    this.usageLimitedUntil = launchParts.usageLimitedUntil ?? (card => usageLimitResetOf(clientTranscript(launchParts.env, card.worktree, card.session)))
    this.declare(LAUNCH_NODE)
  }

  private machineClaimant(cardId: number): MachineClaimant {
    return { bus: busNameOfDb(this.db), role: 'launch', cardId }
  }

  stopOverdue(): number[] {
    const stopped: number[] = []
    if (this.parts.mode !== 'live')
      return stopped
    this.expireUnstartedLeases()
    for (const start of this.db.prepare(RUNNING_STARTS).all() as unknown as RunningStart[]) {
      const card = startedCardOf(start.payload)
      if (card === null)
        continue
      if (this.movedToCheap(start, card)) {
        if (this.withdrawFromLadder(start, card))
          stopped.push(start.card_id)
        continue
      }
      if (this.endedWithoutPullRequest(start, card)) {
        if (this.db.prepare(STOPPED_SINCE).get(start.card_id, start.id) === undefined && this.stopEnded(start, card))
          stopped.push(start.card_id)
        continue
      }
      if (this.sessionProcess(card) !== 'live')
        continue
      this.waitOnAmend(start, card)
      this.pulse(start, card)
      const now = this.parts.clock().getTime()
      const ownerStop = ownerMovedSince(this.db, start.card_id, 'stop', start.id)
      if (ownerStop || now - Date.parse(start.ts) >= LAUNCH_LIMIT_MS) {
        if (this.stopLive(start, card, ownerStop ? 'owner-stop' : 'time-limit', ownerStop ? `the owner stopped card #${start.card_id} session ${card.session} (pid ${card.pid})` : `card #${start.card_id} ran past ${LAUNCH_LIMIT_MINUTES} minutes since ${start.ts}`))
          stopped.push(start.card_id)
        continue
      }
      const sign = this.lastSignOf(start)
      if (card.step !== SESSIONLESS_LADDER_STEP && now - Date.parse(sign) >= HEARTBEAT_SILENCE_MS && this.db.prepare(PR_SINCE).get(start.card_id, start.id) === undefined) {
        if (this.stopLive(start, card, 'no-heartbeat', `card #${start.card_id} session ${card.session} has no pull request and no heartbeat for ${HEARTBEAT_SILENCE_MINUTES} minutes since ${sign}`))
          stopped.push(start.card_id)
      }
    }
    for (const start of this.db.prepare(OUT_OF_RUNNING_STARTS).all() as unknown as RunningStart[]) {
      const card = startedCardOf(start.payload)
      if (card !== null && (start.state === DROPPED_CARD || ownerMovedSince(this.db, start.card_id, 'stop', start.id)) && this.endOutOfRunning(start, card))
        stopped.push(start.card_id)
    }
    return stopped
  }

  expireUnstartedLeases(): string[] {
    const now = this.parts.clock().getTime()
    const lapsed = (this.db.prepare(UNSTARTED_LAUNCH_LEASES).all() as unknown as UnstartedLease[]).filter(row => now - Date.parse(row.leased_at) >= LAUNCH_START_MS)
    for (const row of lapsed)
      failTask(this.db, this.ts(), { taskKey: row.task_key, queue: 'launch', cardId: row.card_id, pr: null, head: null, leaseGen: row.lease_gen, actor: this.actor }, { reason: LAUNCH_UNSTARTED, withdraw: false }, this.launchParts.silentMs)
    return lapsed.map(row => row.task_key)
  }

  private endOutOfRunning(start: RunningStart, card: StartedCard): boolean {
    const live = this.sessionProcess(card) === 'live'
    if (live)
      this.starters[card.contour]?.stop(card)
    if (this.sessionProcess(card) !== 'gone')
      return false
    this.launchParts.collected?.(card, { cardId: start.card_id, ts: start.ts })
    const [moved, at, gone] = start.state === DROPPED_CARD ? ['is dropped', 'the drop', 'ended on its own'] : [`was stopped by the owner while ${start.state}`, 'the owner stop', 'had no process left, so the bus records its end']
    return appendEvent(this.db, { ts: this.ts(), type: CARD_SESSION_ENDED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${start.dedupe_key}`, payload: { session: card.session, pgid: card.pgid, stopped: live, detail: `card #${start.card_id} ${moved}; its session ${card.session} ${live ? `was stopped at ${at}` : gone}` }, legacy: false })
  }

  private pulse(start: RunningStart, card: StartedCard): void {
    const last = this.db.prepare(LAST_PULSE).get(start.card_id, start.id) as { ts: string } | undefined
    const now = this.parts.clock().getTime()
    if (now - Date.parse(last?.ts ?? start.ts) < PULSE_MS)
      return
    const ts = this.ts()
    appendEvent(this.db, { ts, type: CARD_PULSE, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_PULSE}:${start.dedupe_key}:${ts}`, payload: { session: card.session, pgid: card.pgid, since: start.ts }, legacy: false })
  }

  private lastSignOf(start: RunningStart): string {
    const beat = lastHeartbeat(this.db, start.card_id)
    return beat !== null && Date.parse(beat.ts) > Date.parse(start.ts) ? beat.ts : start.ts
  }

  private sessionProcess(card: StartedCard): 'live' | 'gone' {
    if (!recordedPidLivesIn(card.pid, this.pidAlive))
      return 'gone'
    return launchProcess({ pgid: card.pgid, session: card.session }, this.processes) === 'live' ? 'live' : 'gone'
  }

  private stopLive(start: RunningStart, card: StartedCard, cause: string, why: string): boolean {
    if (this.sessionProcess(card) !== 'live')
      return false
    this.starters[card.contour]?.stop(card)
    if (this.sessionProcess(card) !== 'gone')
      return false
    this.launchParts.collected?.(card, { cardId: start.card_id, ts: start.ts })
    return this.faultStop(this.ts(), start, `${CARD_STOPPED}:${cause}:${start.dedupe_key}`, `${cause}: ${why}`)
  }

  private endedWithoutPullRequest(start: RunningStart, card: StartedCard): boolean {
    if (card.step === SESSIONLESS_LADDER_STEP || this.sessionProcess(card) !== 'gone')
      return false
    return this.db.prepare(GHOST_ROW_SINCE).get(start.card_id, start.id) === undefined
      && this.db.prepare(PR_SINCE).get(start.card_id, start.id) === undefined
      && this.db.prepare(VERIFIED_SINCE).get(start.card_id, start.id) === undefined
  }

  private stopEnded(start: RunningStart, card: StartedCard): boolean {
    const session: SessionStart = { cardId: start.card_id, ts: start.ts }
    const usageReset = this.usageLimitWaitOf(start)
    if (usageReset !== null)
      return this.relaunchAfterTheReset(start, card, session, usageReset)
    const missing = card.contour === 'cheap' ? this.launchParts.collected?.(card, session) ?? null : null
    const atLine = card.contour === 'cheap' && (this.launchParts.atContextLine?.(card) ?? false)
    if (missing !== null && !atLine) {
      const reset = this.usageLimitedUntil(card)
      if (reset !== null)
        return this.waitForTheReset(start, card, reset)
      return this.faultStop(this.ts(), start, `${CARD_STOPPED}:${REPORT_MISSING}:${start.dedupe_key}`, missing, REPORT_MISSING)
    }
    const handedOff = this.launchParts.handedOff?.(session) ?? false
    if ((atLine || handedOff) && this.sessionStopOf(start, session) !== null)
      return this.stopWithoutPullRequest(start, card, session, null)
    if (atLine)
      return this.continueAtContextLine(start, card, session, handedOff)
    const amend = this.amendSince(start)
    if (card.contour === 'cheap' && this.launchParts.continuer !== undefined && amend !== null && (handedOff || (this.launchParts.resulted?.(card, session) ?? false)))
      return this.continueSession(start, card, this.launchParts.continuer, `card #${start.card_id} session ${card.session} ended on body ${shortSha(amend.started)}, amended since to ${shortSha(amend.amended)}`)
    if (card.contour === 'cheap' && this.launchParts.continuer !== undefined && handedOff)
      return this.continueSession(start, card, this.launchParts.continuer, `card #${start.card_id} session ${card.session} exited at a boundary with its handoff written`)
    if (!(this.launchParts.resulted?.(card, session) ?? false))
      return this.stopDeadSession(start, card)
    if (card.contour === 'ladder')
      return this.waitForApproval(start, card)
    if (this.closeProbeByReport(start, card, session) || this.publishAtEddiesWarn(start, card, session))
      return false
    const published = this.publishACommit(start, card, session)
    if (published === true)
      return false
    return this.stopWithoutPullRequest(start, card, session, published === false ? null : published)
  }

  private usageLimitWaitOf(start: RunningStart): string | null {
    const row = this.db.prepare(USAGE_LIMIT_WAIT_OF_START).get(start.card_id, `${USAGE_LIMIT_WAIT_PREFIX}${start.dedupe_key}`) as { payload: string } | undefined
    if (row === undefined)
      return null
    const { detail } = JSON.parse(row.payload) as { detail?: unknown }
    return typeof detail === 'string' ? usageLimitResetIn(detail) : null
  }

  private waitForTheReset(start: RunningStart, card: StartedCard, reset: string): boolean {
    const detail = usageLimitDetail(start.card_id, card.session, reset)
    appendEvent(this.db, { ts: this.ts(), type: CARD_WAITING, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${USAGE_LIMIT_WAIT_PREFIX}${start.dedupe_key}`, payload: { reason: USAGE_LIMIT, code: USAGE_LIMIT, session: card.session, detail }, legacy: false })
    return false
  }

  private relaunchAfterTheReset(start: RunningStart, card: StartedCard, session: SessionStart, reset: string): boolean {
    if (this.parts.clock().getTime() < Date.parse(reset))
      return false
    const exited = `card #${start.card_id} session ${card.session} ended on the account's usage limit, which reset at ${reset}`
    const { continuer } = this.launchParts
    if (continuer === undefined)
      return this.stopContinuation(start, 'continuation-refused', `${exited}; no continuer is wired, so no session continues from it`)
    if (!(this.launchParts.handedOff?.(session) ?? false))
      this.launchParts.buildHandoff?.(card, session, admittedBodyText(this.db, start.card_id))
    return this.continueSession(start, card, continuer, exited)
  }

  private usageLimitResetPending(): string | null {
    const row = this.db.prepare(LATEST_USAGE_LIMIT_WAIT).get() as { payload: string } | undefined
    const { detail } = row === undefined ? {} : JSON.parse(row.payload) as { detail?: unknown }
    const reset = typeof detail === 'string' ? usageLimitResetIn(detail) : null
    return reset !== null && this.parts.clock().getTime() < Date.parse(reset) ? reset : null
  }

  private continueAtContextLine(start: RunningStart, card: StartedCard, session: SessionStart, handedOff: boolean): boolean {
    const exited = `card #${start.card_id} session ${card.session} stopped at the context warn and the bus pushed nothing from it`
    const { continuer } = this.launchParts
    if (continuer === undefined)
      return this.stopContinuation(start, 'continuation-refused', `${exited}; no continuer is wired, so no session continues from it`)
    if (handedOff)
      return this.continueSession(start, card, continuer, exited)
    if (this.launchParts.spendStopped?.(card) ?? false)
      return this.stopContinuation(start, 'eddies-stop', `${exited}; it also hit the session spend stop and left no valid handoff, so no fresh session spends past that stop`)
    const reported = this.reportedStopReason(start)
    if (this.continuationsUsed(start) < MAX_RESTARTS)
      this.launchParts.buildHandoff?.(card, session, admittedBodyText(this.db, start.card_id))
    return this.continueSession(start, card, continuer, exited, reported)
  }

  private sessionStopOf(start: RunningStart, session: SessionStart): SessionStop | null {
    return sessionStopOf(reportedQuestions(this.launchParts.reportOf?.(session) ?? null), text => pathsOutsideTheBody(this.db, start.card_id, text))
  }

  private reportedStopReason(start: RunningStart): string | null {
    return reportedStopReason(this.launchParts.reportOf?.({ cardId: start.card_id, ts: start.ts }) ?? null)
  }

  private continuationsUsed(start: RunningStart): number {
    return Number((this.db.prepare(CONTINUATIONS).get(start.card_id, start.card_id) as { n: number }).n)
  }

  private kindOf(cardId: number): string | null {
    const text = admittedBodyText(this.db, cardId)
    const parsed = text === null ? null : parseParkingFile(`${cardId}.md`, text)
    return parsed?.kind === 'parked' ? parsed.parked.task.card.kind : null
  }

  private closeProbeByReport(start: RunningStart, card: StartedCard, session: SessionStart): boolean {
    const closing = this.kindOf(start.card_id) === 'probe' ? reportClosingOf(this.launchParts.reportOf?.(session) ?? null) : null
    if (closing === null)
      return false
    const detail = `card #${start.card_id} probe session ${card.session} ended with its report ${closing.report} and no pull request, which a probe does not open`
    appendEvent(this.db, { ts: this.ts(), type: CARD_VERIFIED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_VERIFIED}:${start.card_id}:${start.dedupe_key}`, payload: { ...closing, session: card.session, detail }, legacy: false })
    return true
  }

  private publishAtEddiesWarn(start: RunningStart, card: StartedCard, session: SessionStart): boolean {
    if (card.contour !== 'cheap' || this.launchParts.publish === undefined || !(this.launchParts.warned?.(card) ?? false))
      return false
    this.launchParts.publish(card, session)
    if (this.db.prepare(PR_SINCE).get(start.card_id, start.id) === undefined)
      return this.db.prepare(STOPPED_SINCE).get(start.card_id, start.id) !== undefined
    const detail = `eddies-warn: card #${start.card_id} session ${card.session} ended at the Eddies warning; the shift committed, pushed and opened its pull request from ${card.worktree} before the stop`
    appendEvent(this.db, { ts: this.ts(), type: CARD_SESSION_ENDED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${start.dedupe_key}`, payload: { session: card.session, pgid: card.pgid, stopped: false, detail }, legacy: false })
    return true
  }

  private publishACommit(start: RunningStart, card: StartedCard, session: SessionStart): boolean | string {
    if (card.contour !== 'cheap' || this.launchParts.publish === undefined || (this.launchParts.warned?.(card) ?? false) || !(this.launchParts.committed?.(card) ?? false))
      return false
    this.launchParts.publish(card, session)
    if (this.db.prepare(PR_SINCE).get(start.card_id, start.id) === undefined)
      return this.db.prepare(STOPPED_SINCE).get(start.card_id, start.id) !== undefined || `the bus ran tree-pr over the commit in ${card.worktree} and it opened no pull request`
    const detail = `card #${start.card_id} session ${card.session} ended with no pull request and a commit in ${card.worktree}; the bus ran tree-pr and it opened the pull request`
    appendEvent(this.db, { ts: this.ts(), type: CARD_SESSION_ENDED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${start.dedupe_key}`, payload: { session: card.session, pgid: card.pgid, stopped: false, published: true, detail }, legacy: false })
    return true
  }

  private movedToCheap(start: RunningStart, card: StartedCard): boolean {
    if (card.contour !== 'ladder')
      return false
    const admitted = this.db.prepare(LATEST_ADMISSION).get(start.card_id) as { payload: string } | undefined
    return admitted !== undefined && (JSON.parse(admitted.payload) as Record<string, unknown>).contour === 'cheap'
  }

  private withdrawFromLadder(start: RunningStart, card: StartedCard): boolean {
    if (this.sessionProcess(card) === 'live')
      this.starters.ladder?.stop(card)
    if (this.sessionProcess(card) !== 'gone')
      return false
    const admitted = this.db.prepare(LATEST_ADMISSION).get(start.card_id) as { payload: string }
    const { lane, decision, contour, depends } = JSON.parse(admitted.payload) as Record<string, unknown>
    const detail = `${WITHDRAWN_TO_CHEAP}: card #${start.card_id} was moved to cheap; its ladder session ${card.session} at step ${card.step ?? '-'} is withdrawn and the card queues again on the cheap path`
    return inTransaction(this.db, () => {
      const ts = this.ts()
      const dedupe = `${WITHDRAWN_TO_CHEAP}:${start.dedupe_key}`
      if (!appendEvent(this.db, { ts, type: CARD_STOPPED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${dedupe}`, payload: { reason: 'fault', code: WITHDRAWN_TO_CHEAP, detail }, legacy: false }))
        return false
      const task = this.db.prepare(LAUNCH_TASK_OF_CARD).get(start.card_id) as LaunchTaskRow | undefined
      if (task?.state === COMPLETED)
        this.supersedeTheStoppedLaunch(ts, start.card_id, task)
      appendEvent(this.db, { ts, type: CARD_ADMITTED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${dedupe}`, payload: { lane, decision, contour, depends, admission: dedupe }, legacy: false })
      return true
    })
  }

  private waitForApproval(start: RunningStart, card: StartedCard): boolean {
    const detail = `card #${start.card_id} ladder step ${card.step ?? '-'} of session ${card.session} ended with a result and no ghost row; its next step waits for the approval of its brief`
    appendEvent(this.db, { ts: this.ts(), type: CARD_WAITING, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_WAITING}:${start.dedupe_key}`, payload: { reason: LADDER_APPROVAL, step: card.step ?? null, session: card.session, detail }, legacy: false })
    return false
  }

  private amendSince(start: RunningStart): BodyAmend | null {
    const bodies = admittedBodies(this.db, start.card_id)
    const amended = bodies[0]
    const started = bodies.find(body => body.id < start.id)
    if (amended === undefined || started === undefined || amended.id <= start.id || started.sha === amended.sha || onlyThePriorityMoved({ started_text: started.text, amended_text: amended.text }))
      return null
    return { started: started.sha, amended: amended.sha }
  }

  private waitOnAmend(start: RunningStart, card: StartedCard): void {
    const amend = this.amendSince(start)
    if (amend === null)
      return
    const restart = card.contour === 'cheap' && this.launchParts.continuer !== undefined ? 'then it is restarted on the amended text' : 'and the amended text reaches the next session the card starts'
    const detail = `card #${start.card_id} was amended from body ${shortSha(amend.started)} to ${shortSha(amend.amended)} after session ${card.session} started on the first; the session runs to its end, ${restart}`
    appendEvent(this.db, { ts: this.ts(), type: CARD_WAITING, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_WAITING}:${AMENDED_AFTER_START}:${start.dedupe_key}:${amend.amended}`, payload: { reason: AMENDED_AFTER_START, session: card.session, started: amend.started, amended: amend.amended, detail }, legacy: false })
  }

  private continueSession(start: RunningStart, card: StartedCard, continuer: SessionContinuer, exited: string, reported: string | null = this.reportedStopReason(start)): boolean {
    if (waitHeldAtTheExit(this.db, this.ts(), this.actor, { cardId: start.card_id, startKey: start.dedupe_key, session: card.session, exited }) || bodyNotFoldedYet(this.db, start.card_id) || this.usageLimitResetPending() !== null)
      return false
    const used = this.continuationsUsed(start)
    if (used >= MAX_RESTARTS)
      return this.stopContinuation(start, 'continuation-limit', `${exited}; ${used} of ${MAX_RESTARTS} continuations used (D-104), the card is not continued again`)
    const admitted = this.db.prepare(LATEST_ADMISSION).get(start.card_id) as { payload: string } | undefined
    const lane = admitted === undefined ? null : (JSON.parse(admitted.payload) as Record<string, unknown>).lane
    if (typeof lane !== 'string')
      return this.stopContinuation(start, 'continuation-refused', `${exited}; its admission names no lane, so no session continues from it`)
    const claimant = this.machineClaimant(start.card_id)
    if (this.machine.claim(claimant).kind === 'refused')
      return false
    const begun = continuer.continueFrom({ cardId: start.card_id, lane }, card)
    if (begun.kind === 'refused') {
      this.machine.release(claimant)
      return this.stopContinuation(start, 'continuation-refused', `${exited}; the continuation was refused: ${begun.denial.detail}`)
    }
    const { input, ...launched } = begun.card
    const next: StartedCard = { ...launched, contour: card.contour }
    this.machine.started(claimant, next)
    const payload = { ...next, continuation: used + 1, from: card.session, ...(reported === null ? {} : { stop_reason: reported }), ...storedInput(this.launchParts.prompts, input) }
    if (!appendEvent(this.db, { ts: this.ts(), type: CARD_CONTINUED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_CONTINUED}:${start.dedupe_key}`, payload, legacy: false }))
      this.starters[card.contour]?.stop(next)
    return false
  }

  private stopContinuation(start: RunningStart, cause: string, detail: string): boolean {
    return this.faultStop(this.ts(), start, `${CARD_STOPPED}:${cause}:${start.dedupe_key}`, `${cause}: ${detail}`)
  }

  private faultStop(ts: string, start: RunningStart, dedupeKey: string, detail: string, code?: string): boolean {
    const recorded = appendEvent(this.db, { ts, type: CARD_STOPPED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey, payload: { reason: 'fault', detail, ...(code === undefined ? {} : { code }) }, legacy: false })
    const task = this.db.prepare(LAUNCH_TASK_OF_CARD).get(start.card_id) as LaunchTaskRow | undefined
    if (!recorded || task === undefined)
      return recorded
    if (task.state === COMPLETED)
      this.supersedeTheStoppedLaunch(ts, start.card_id, task)
    appendEvent(this.db, { ts, type: BOARD_ALARM, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${dedupeKey}`, payload: { task_key: task.task_key, reason: 'fault', detail }, legacy: false })
    return recorded
  }

  private supersedeTheStoppedLaunch(ts: string, cardId: number, task: LaunchTaskRow): void {
    const generation = generationOfKey(task.task_key, { queue: 'launch', cardId })
    const event: BusEvent = { ts, type: TASK_SUPERSEDED, actor: this.actor, cardId, pr: null, head: null, dedupeKey: `${TASK_SUPERSEDED}:${task.task_key}:after-${task.event_id}`, payload: { task_key: task.task_key, queue: 'launch', ...generationField(generation) }, legacy: false }
    if (appendEvent(this.db, event))
      TASK_FOLDS[TASK_SUPERSEDED]!(this.db, storedByKey(this.db, event.dedupeKey))
  }

  private stopWithoutPullRequest(start: RunningStart, card: StartedCard, session: SessionStart, refusal: string | null): boolean {
    const questions = reportedQuestions(this.launchParts.reportOf?.(session) ?? null)
    if (questions.length > 0 && questions.every(question => timeoutUnderLoadOutside(question, paths => pathsOutsideTheBody(this.db, start.card_id, paths.join('\n')))))
      return this.retryUnderLoad(start, card, session, questions)
    if (questions.length > 0)
      return this.launchParts.continuer !== undefined && this.continuationsUsed(start) < MAX_RESTARTS && lacksItsPackages(card.worktree) ? this.continueSession(start, card, this.launchParts.continuer, `card #${start.card_id} session ${card.session} asked a question from ${card.worktree}, whose lockfile names packages the tree lacks; the bus prepares the tree for the next session`) : this.stopOnQuestions(start, card, questions, splitByRepository(card.worktree, pathsOutsideTheBody(this.db, start.card_id, questions.join('\n'))), refusal, reportedStopReason(this.launchParts.reportOf?.(session) ?? null))
    const ended = noPullRequestDetail(start.card_id, card.session, this.launchParts.endedWith?.(session) ?? null)
    const detail = refusal === null ? ended : `${ended}; ${refusal}`
    return inTransaction(this.db, () => this.faultStop(this.ts(), start, `${LAUNCH_STOP_WITH_NO_PULL_REQUEST}${start.dedupe_key}`, detail))
  }

  private retryUnderLoad(start: RunningStart, card: StartedCard, session: SessionStart, questions: readonly string[]): boolean {
    const detail = machineOverloadedLine(start.card_id, questions.join('; '))
    appendEvent(this.db, { ts: this.ts(), type: CARD_WAITING, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_WAITING}:${MACHINE_OVERLOADED}:${start.dedupe_key}`, payload: { reason: MACHINE_OVERLOADED, code: MACHINE_OVERLOADED, session: card.session, detail }, legacy: false })
    if (card.contour === 'cheap' && this.launchParts.publish !== undefined) {
      this.launchParts.publish(card, session)
      if (this.db.prepare(PR_SINCE).get(start.card_id, start.id) !== undefined) {
        appendEvent(this.db, { ts: this.ts(), type: CARD_SESSION_ENDED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${start.dedupe_key}`, payload: { session: card.session, pgid: card.pgid, stopped: false, published: true, detail: `${detail}; the bus ran tree-pr and it opened the pull request` }, legacy: false })
        return false
      }
      if (this.db.prepare(STOPPED_SINCE).get(start.card_id, start.id) !== undefined)
        return false
    }
    const { continuer } = this.launchParts
    if (continuer === undefined)
      return this.stopContinuation(start, 'continuation-refused', `${detail}; no continuer is wired, so the session is not retried`)
    return this.continueSession(start, card, continuer, detail)
  }

  private openQuestionWaits(ts: string, start: RunningStart, card: StartedCard, questions: readonly string[]): void {
    for (const question of questions)
      openOwnerWait(this.db, ts, this.actor, { need: 'decision', text: `card #${start.card_id} session ${card.session} asks: ${question}`, command: cardDecisionCommand(start.card_id), card: start.card_id })
  }

  private stopOnQuestions(start: RunningStart, card: StartedCard, questions: readonly string[], asked: AskedPaths, refusal: string | null, reported: string | null): boolean {
    const { widen, dropped } = asked
    const ended = `card #${start.card_id} session ${card.session} ended with no pull request`
    const asks = widen.length === 0 ? `${ended} and asks: ${questions.join('; ')}` : `${ended} and asks to widen its touches to ${widen.join(', ')}: ${questions.join('; ')}`
    const named = dropped.length === 0 ? asks : `${asks}; ${NOT_A_REPOSITORY_PATH}: ${dropped.join(', ')}`
    const detail = refusal === null ? named : `${named}; ${refusal}`
    return inTransaction(this.db, () => {
      const ts = this.ts()
      const recorded = appendEvent(this.db, { ts, type: CARD_STOPPED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${LAUNCH_STOP_WITH_NO_PULL_REQUEST}${start.dedupe_key}`, payload: { reason: QUESTION_AGENT, code: widen.length === 0 ? OPEN_QUESTION : OUTSIDE_TOUCHES, blocker: questions.join('; '), paths: [...widen], detail, widen: [...widen], ...(dropped.length === 0 ? {} : { dropped: [...dropped] }), ...(reported === null ? {} : { stop_reason: reported }) }, legacy: false })
      const task = this.db.prepare(LAUNCH_TASK_OF_CARD).get(start.card_id) as LaunchTaskRow | undefined
      if (recorded && task?.state === COMPLETED)
        this.supersedeTheStoppedLaunch(ts, start.card_id, task)
      if (recorded && widen.length === 0)
        this.openQuestionWaits(ts, start, card, questions)
      return recorded
    })
  }

  private stopDeadSession(start: RunningStart, card: StartedCard): boolean {
    const admitted = this.db.prepare(LATEST_ADMISSION).get(start.card_id) as { payload: string } | undefined
    const deaths = Number((this.db.prepare(SESSION_DEATHS).get(start.card_id) as { n: number }).n) + 1
    const final = deaths >= SESSION_DEATH_CAP
    const ended = `session-end: card #${start.card_id} session ${card.session} ended with no pull request, commit or handoff`
    const detail = final ? `${ended}; session death ${deaths} of ${SESSION_DEATH_CAP} (D-104), the card is not queued again` : ended
    const ts = this.ts()
    const recorded = this.faultStop(ts, start, `${CARD_STOPPED}:session-end:${start.dedupe_key}`, detail)
    if (recorded && !final && admitted !== undefined) {
      const { lane, decision, contour, depends } = JSON.parse(admitted.payload) as Record<string, unknown>
      const admission = `session-end:${start.dedupe_key}`
      appendEvent(this.db, { ts, type: CARD_ADMITTED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${admission}`, payload: { lane, decision, contour, depends, admission }, legacy: false })
    }
    return recorded
  }

  protected override executes(): boolean {
    return this.parts.mode === 'live'
  }

  protected candidates(): QueuedTask[] {
    if (!this.executes())
      return launchTasks(this.db)
    const ts = this.ts()
    layLanes(this.db, this.lanes(), ts, this.actor)
    return launchTasks(this.db, laneOverlapRecorder(this.db, ts, this.actor))
  }

  protected override derivedCandidates(): QueuedTask[] {
    return launchTasks(this.db)
  }

  protected handle(lease: Lease): LaunchStep {
    if (bodyNotFoldedYet(this.db, lease.cardId))
      return this.waitOn(lease, BODY_NOT_FOLDED, new Date(this.parts.clock().getTime() + TICK_MS).toISOString())
    const ownerSaid = ownerMovedSince(this.db, lease.cardId, 'launch')
    if (!ownerSaid && cardHoldOf(this.db, lease.cardId) !== null)
      return this.waitOn(lease, CARD_HELD, new Date(this.parts.clock().getTime() + HOLD_RECHECK_MS).toISOString())
    const held = ownerSaid ? null : heldSessionStop(this.db, lease.cardId)
    if (held !== null) {
      console.log(`${prefixOf('launch')}${lease.taskKey}: ${heldStopLine(lease.cardId, held)}`)
      return this.waitOn(lease, held.code, new Date(this.parts.clock().getTime() + HOLD_RECHECK_MS).toISOString())
    }
    const usageReset = ownerSaid ? null : this.usageLimitResetPending()
    if (usageReset !== null)
      return this.waitOn(lease, USAGE_LIMIT, usageReset)
    const hold = ownerSaid ? null : startHold(this.db, lease.cardId, this.lanes(), this.machine)
    if (hold !== null)
      return this.waitOn(lease, holdReason(hold), new Date(this.parts.clock().getTime() + MACHINE_POLL_MS).toISOString())
    const claimant = this.machineClaimant(lease.cardId)
    const claim = this.machine.claim(claimant)
    if (claim.kind === 'refused' && !ownerSaid)
      return this.waitOn(lease, holdReason({ kind: 'machine', ...claim.hold }), new Date(this.parts.clock().getTime() + MACHINE_POLL_MS).toISOString())
    return this.launchClaimed(lease, claimant)
  }

  private launchClaimed(lease: Lease, claimant: MachineClaimant): LaunchStep {
    try {
      const step = this.executor.launch(lease)
      if (step.kind === 'started')
        this.machine.started(claimant, step.card)
      else
        this.machine.release(claimant)
      return step
    }
    catch (error) {
      this.machine.release(claimant)
      throw error
    }
  }

  protected override stepLine(step: LaunchStep): string | null {
    if (step.kind === 'started')
      return `${step.taskKey}: started session ${step.card.session} as pid ${step.card.pid} (its own process group) in ${step.card.worktree} on ${step.card.branch} from ${step.card.base}`
    if (step.kind === 'fenced')
      return `${step.taskKey}: the lease moved on or the card is no longer queued; nothing written`
    return super.stepLine(step)
  }
}
