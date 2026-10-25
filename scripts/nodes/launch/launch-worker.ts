import type { DatabaseSync } from 'node:sqlite'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { ProcessTable } from '../restart/chain-process.js'
import type { BusEvent } from '../../core/db.js'
import type { LadderSteps } from '../../ladder/ladder-starter.js'
import type { Contour } from './launch-candidates.js'
import type { CardStarter, LaunchOutcome, StartedCard } from './launch-executor.js'
import type { SessionContinuer, StarterPlaces, StarterPorts } from './launch-starter.js'
import type { Lease } from '../../core/lease.js'
import type { DetectionMode, WaitStep } from '../../core/node.js'
import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { QueuedTask } from '../../core/queue.js'
import type { TreeFile } from './session-journal.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../../src/card/parking.js'
import { busDirOf, machineBusPath } from '../../core/bus-path.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_CONTINUED, CARD_PULSE, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, CARD_WAITING, GHOST_ROW, LADDER_APPROVAL, MERGE_DONE, PR_CLOSED, PR_OBSERVED, PR_OPENED, REDUCED, TASK_COMPLETED, TASK_ENQUEUED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_REQUEUED, TASK_SUPERSEDED } from '../../core/events.js'
import { FACTORY_RUNTIME } from '../../core/factory-paths.js'
import { ghostLinesText } from '../../core/journal.js'
import { reviewOf } from '../../ladder/verdict.js'
import { commandWords, realIsolationReader } from '../../ports/isolation.js'
import { sessionEnv } from '../../ports/session.js'
import { taskWorktree, worktreeHome } from '../../ports/worktree-home.js'
import { continuationRefusal, CONTINUE_PROMPT, eddiesEvidence, MAX_RESTARTS } from './continuation.js'
import { briefBody, briefPathOf, ladderStep, reviewBody, tasksFilePathOf, tasksFileText } from '../../ladder/ladder.js'
import { eddiesJournalPath, reportPath } from '../../core/places.js'
import { renderPrompt } from './prompt.js'
import { reportClosingOf } from './tree-pr.js'
import { NOT_A_BACKFILL } from '../../core/backfill-source.js'
import { BUILD_DIR, BUILT_MODULE, builtEntryOf, installedPackage } from '../../supervisor/bg.js'
import { DROPPED_CARD, RUNNING_CARD } from '../../core/card-automaton.js'
import { CARD_BODIES, cardBodyText } from '../../core/card-bodies.js'
import { launchProcess, REAL_PROCESSES } from '../restart/chain-process.js'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath, inTransaction, openBus, openOwnerWait } from '../../core/db.js'
import { heartbeatEnv, lastHeartbeat } from '../../supervisor/heartbeat.js'
import { generationOfKey } from '../../core/identifiers.js'
import { handoffDir } from '../../intake/import.js'
import { LadderCardStarter } from '../../ladder/ladder-starter.js'
import { laneOverlapRecorder, layLanes, repositoryLanes } from './lane-assign.js'
import { bodyNotFoldedYet } from './launch-candidates.js'
import { LaunchExecutor } from './launch-executor.js'
import { cardCommand, gitChangedPaths, HTTPS_ORIGIN_ENV, killQuietly, psPgid, shellWord, ShiftCardStarter, spawnDetached, treePrCommand } from './launch-starter.js'
import { LEGACY_REASON, WITHDRAW_LEGACY_FLAG, withdrawLegacyLaunchTasks } from './launch-withdraw.js'
import { failTask } from '../../core/lease.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { Node, prefixOf, runNode } from '../../core/node.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { promptsDirOf, storedInput } from '../../ports/prompt-store.js'
import { COMPLETED, generationField, launchTasks, LEASED, TASK_FOLDS } from '../../core/queue.js'
import { transcriptFile } from './session-journal.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { openDatabase } from '../../core/sqlite.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { storedByKey } from '../../core/stored.js'

export const PREFIX = prefixOf('launch')
export const LAUNCH_DIR = 'launch'

const TASK_START_SCRIPT = 'task:start'
export const TREE_PR_ENTRY = FACTORY_RUNTIME.shiftTreePr.replace(/\.ts$/, '')
export const HEADER_FILE = path.join(import.meta.dirname, '..', '..', FACTORY_RUNTIME.shiftHeader)

export function publishedTreePr(repo: string, installed: string | null): string {
  if (installed === null)
    return treePrCommand(repo)
  return `${shellWord(process.execPath)} ${shellWord(path.join(installed, BUILD_DIR, `${TREE_PR_ENTRY}${BUILT_MODULE}`))}`
}

export function taskStartCommand(installed: string | null): { file: string, args: string[] } {
  if (installed === null)
    return { file: 'pnpm', args: ['--silent', TASK_START_SCRIPT] }
  return { file: process.execPath, args: [builtEntryOf(installed, TASK_START_SCRIPT)] }
}

export function launchDirOf(home: string, busPath: string): string {
  const resolved = path.resolve(busPath)
  return resolved === machineBusPath(home) ? path.join(path.dirname(resolved), 'shift', LAUNCH_DIR) : path.join(busDirOf(resolved), LAUNCH_DIR)
}

export function launchPlaces(home: string, repo: string, busPath: string = machineBusPath(home), installed: string | null = installedPackage()): StarterPlaces {
  return {
    launchDir: launchDirOf(home, busPath),
    claude: 'claude',
    treePr: publishedTreePr(repo, installed),
  }
}

export const LAUNCH_LIMIT_MINUTES = 600

const LAUNCH_LIMIT_MS = LAUNCH_LIMIT_MINUTES * 60_000

export const HEARTBEAT_SILENCE_MINUTES = 20

const HEARTBEAT_SILENCE_MS = HEARTBEAT_SILENCE_MINUTES * 60_000

const LEGACY_MERGE = 'merge'
const LEGACY_PATH = 'path'

export const LAUNCH_ON = [CARD_ADMITTED, CARD_STARTED, CARD_CLOSED, CARD_STOPPED, PR_CLOSED, PR_OBSERVED, PR_OPENED, LEGACY_MERGE, LEGACY_PATH, TASK_ENQUEUED, TASK_REQUEUED, TASK_COMPLETED, TASK_FAILED, TASK_SUPERSEDED, TASK_RELEASED, TASK_EXPIRED, MERGE_DONE, GHOST_ROW, REDUCED] as const

export type LaunchStep = LaunchOutcome | WaitStep

export const BODY_NOT_FOLDED = 'body_not_folded'

export interface LaunchNodeParts {
  db: DatabaseSync
  starter: CardStarter
  ladder?: CardStarter
  clock: () => Date
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
  processes?: ProcessTable
  resulted?: (card: StartedCard, start: SessionStart) => boolean
  endedWith?: (start: SessionStart) => string | null
  handedOff?: (start: SessionStart) => boolean
  reportOf?: (start: SessionStart) => string | null
  warned?: (card: StartedCard) => boolean
  publish?: (card: StartedCard, start: SessionStart) => void
  continuer?: SessionContinuer
  isolation: IsolationReader
  prompts?: string
  lanes?: () => number
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
}

const SESSION_STARTS = `'${CARD_STARTED}', '${CARD_CONTINUED}'`

function latestStartsOf(state: string, condition = ''): string {
  return `
  SELECT e.id, e.card_id, e.ts, e.dedupe_key, e.payload FROM cards AS c
  JOIN events AS e ON e.card_id = c.card_id AND e.type IN (${SESSION_STARTS}) AND e.legacy = 0
    AND e.id = (SELECT MAX(id) FROM events WHERE card_id = c.card_id AND type IN (${SESSION_STARTS}) AND legacy = 0)
  WHERE c.state = '${state}'${condition}
  ORDER BY c.card_id
`
}

const RUNNING_STARTS = latestStartsOf(RUNNING_CARD)

const DROPPED_STARTS = latestStartsOf(DROPPED_CARD, `
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

const CONTINUATIONS = `SELECT count(*) AS n FROM events WHERE type = '${CARD_CONTINUED}' AND legacy = 0 AND card_id = ?
  AND id > (SELECT coalesce(MAX(id), 0) FROM events WHERE type = '${CARD_STARTED}' AND legacy = 0 AND card_id = ?)`

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

const QUESTION_TEXT = /^question:[ \t]*(\S.*)$/gm

function reportQuestions(report: string | null): string[] {
  return report === null ? [] : [...report.matchAll(QUESTION_TEXT)].map(found => found[1].trim())
}

const LATEST_ADMISSION = `SELECT payload FROM events WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND card_id = ? AND ${NOT_A_BACKFILL} ORDER BY id DESC LIMIT 1`

export const AMENDED_AFTER_START = 'amended-after-start'

const BODY_AMENDED_SINCE = `
  SELECT b.text_sha AS amended, (SELECT json_extract(e.payload, '$.textSha') FROM events AS e
    WHERE e.type = '${CARD_ADMITTED}' AND e.legacy = 0 AND e.card_id = b.card_id AND e.id < ? AND json_valid(e.payload) AND json_type(e.payload, '$.textSha') = 'text'
    ORDER BY e.id DESC LIMIT 1) AS started
  FROM ${CARD_BODIES} AS b WHERE b.card_id = ? AND b.admission_event_id > ?
`

interface BodyAmend {
  started: string
  amended: string
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
  private readonly lanes: () => number

  constructor(private readonly launchParts: LaunchNodeParts) {
    super('launch', { db: launchParts.db, clock: launchParts.clock, session: launchParts.session, mode: launchParts.mode, env: launchParts.env })
    this.executor = new LaunchExecutor(launchParts)
    this.starters = { cheap: launchParts.starter, ladder: launchParts.ladder }
    this.processes = launchParts.processes ?? REAL_PROCESSES
    this.lanes = launchParts.lanes ?? repositoryLanes(process.cwd())
    this.subscribe(LAUNCH_ON)
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
      if (now - Date.parse(start.ts) >= LAUNCH_LIMIT_MS) {
        if (this.stopLive(start, card, 'time-limit', `card #${start.card_id} ran past ${LAUNCH_LIMIT_MINUTES} minutes since ${start.ts}`))
          stopped.push(start.card_id)
        continue
      }
      const sign = this.lastSignOf(start)
      if (card.step !== SESSIONLESS_LADDER_STEP && now - Date.parse(sign) >= HEARTBEAT_SILENCE_MS && this.db.prepare(PR_SINCE).get(start.card_id, start.id) === undefined) {
        if (this.stopLive(start, card, 'no-heartbeat', `card #${start.card_id} session ${card.session} has no pull request and no heartbeat for ${HEARTBEAT_SILENCE_MINUTES} minutes since ${sign}`))
          stopped.push(start.card_id)
      }
    }
    for (const start of this.db.prepare(DROPPED_STARTS).all() as unknown as RunningStart[]) {
      const card = startedCardOf(start.payload)
      if (card !== null && this.endDropped(start, card))
        stopped.push(start.card_id)
    }
    return stopped
  }

  expireUnstartedLeases(): string[] {
    const now = this.parts.clock().getTime()
    const lapsed = (this.db.prepare(UNSTARTED_LAUNCH_LEASES).all() as unknown as UnstartedLease[]).filter(row => now - Date.parse(row.leased_at) >= LAUNCH_START_MS)
    for (const row of lapsed)
      failTask(this.db, this.ts(), { taskKey: row.task_key, queue: 'launch', cardId: row.card_id, pr: null, head: null, leaseGen: row.lease_gen, actor: this.actor }, { reason: LAUNCH_UNSTARTED, withdraw: false })
    return lapsed.map(row => row.task_key)
  }

  private endDropped(start: RunningStart, card: StartedCard): boolean {
    const live = this.sessionProcess(card) === 'live'
    if (live)
      this.starters[card.contour]?.stop(card)
    if (this.sessionProcess(card) !== 'gone')
      return false
    const end = live ? 'was stopped at the drop' : 'ended on its own'
    const detail = `card #${start.card_id} is dropped; its session ${card.session} ${end}`
    return appendEvent(this.db, { ts: this.ts(), type: CARD_SESSION_ENDED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${start.dedupe_key}`, payload: { session: card.session, pgid: card.pgid, stopped: live, detail }, legacy: false })
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
    return launchProcess({ pgid: card.pgid, session: card.session }, this.processes) === 'live' ? 'live' : 'gone'
  }

  private stopLive(start: RunningStart, card: StartedCard, cause: string, why: string): boolean {
    if (this.sessionProcess(card) !== 'live')
      return false
    this.starters[card.contour]?.stop(card)
    if (this.sessionProcess(card) !== 'gone')
      return false
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
    const amend = this.amendSince(start)
    const handedOff = this.launchParts.handedOff?.(session) ?? false
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
    return this.stopWithoutPullRequest(start, card, session)
  }

  private kindOf(cardId: number): string | null {
    const text = cardBodyText(this.db, cardId)
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

  private waitForApproval(start: RunningStart, card: StartedCard): boolean {
    const detail = `card #${start.card_id} ladder step ${card.step ?? '-'} of session ${card.session} ended with a result and no ghost row; its next step waits for the approval of its brief`
    appendEvent(this.db, { ts: this.ts(), type: CARD_WAITING, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_WAITING}:${start.dedupe_key}`, payload: { reason: LADDER_APPROVAL, step: card.step ?? null, session: card.session, detail }, legacy: false })
    return false
  }

  private amendSince(start: RunningStart): BodyAmend | null {
    const row = this.db.prepare(BODY_AMENDED_SINCE).get(start.id, start.card_id, start.id) as { started: unknown, amended: string } | undefined
    if (row === undefined || typeof row.started !== 'string' || row.started === row.amended)
      return null
    return { started: row.started, amended: row.amended }
  }

  private waitOnAmend(start: RunningStart, card: StartedCard): void {
    const amend = this.amendSince(start)
    if (amend === null)
      return
    const restart = card.contour === 'cheap' && this.launchParts.continuer !== undefined ? 'then it is restarted on the amended text' : 'and the amended text reaches the next session the card starts'
    const detail = `card #${start.card_id} was amended from body ${shortSha(amend.started)} to ${shortSha(amend.amended)} after session ${card.session} started on the first; the session runs to its end, ${restart}`
    appendEvent(this.db, { ts: this.ts(), type: CARD_WAITING, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_WAITING}:${AMENDED_AFTER_START}:${start.dedupe_key}:${amend.amended}`, payload: { reason: AMENDED_AFTER_START, session: card.session, started: amend.started, amended: amend.amended, detail }, legacy: false })
  }

  private continueSession(start: RunningStart, card: StartedCard, continuer: SessionContinuer, exited: string): boolean {
    const used = Number((this.db.prepare(CONTINUATIONS).get(start.card_id, start.card_id) as { n: number }).n)
    if (used >= MAX_RESTARTS)
      return this.stopContinuation(start, 'continuation-limit', `${exited}; ${used} of ${MAX_RESTARTS} continuations used (D-104), the card is not continued again`)
    const admitted = this.db.prepare(LATEST_ADMISSION).get(start.card_id) as { payload: string } | undefined
    const lane = admitted === undefined ? null : (JSON.parse(admitted.payload) as Record<string, unknown>).lane
    if (typeof lane !== 'string')
      return this.stopContinuation(start, 'continuation-refused', `${exited}; its admission names no lane, so no session continues from it`)
    const begun = continuer.continueFrom({ cardId: start.card_id, lane }, card)
    if (begun.kind === 'refused')
      return this.stopContinuation(start, 'continuation-refused', `${exited}; the continuation was refused: ${begun.denial.detail}`)
    const { input, ...launched } = begun.card
    const next: StartedCard = { ...launched, contour: card.contour }
    const payload = { ...next, continuation: used + 1, from: card.session, ...storedInput(this.launchParts.prompts, input) }
    if (!appendEvent(this.db, { ts: this.ts(), type: CARD_CONTINUED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey: `${CARD_CONTINUED}:${start.dedupe_key}`, payload, legacy: false }))
      this.starters[card.contour]?.stop(next)
    return false
  }

  private stopContinuation(start: RunningStart, cause: string, detail: string): boolean {
    return this.faultStop(this.ts(), start, `${CARD_STOPPED}:${cause}:${start.dedupe_key}`, `${cause}: ${detail}`)
  }

  private faultStop(ts: string, start: RunningStart, dedupeKey: string, detail: string): boolean {
    const recorded = appendEvent(this.db, { ts, type: CARD_STOPPED, actor: this.actor, cardId: start.card_id, pr: null, head: null, dedupeKey, payload: { reason: 'fault', detail }, legacy: false })
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

  private stopWithoutPullRequest(start: RunningStart, card: StartedCard, session: SessionStart): boolean {
    const detail = noPullRequestDetail(start.card_id, card.session, this.launchParts.endedWith?.(session) ?? null)
    const questions = reportQuestions(this.launchParts.reportOf?.(session) ?? null)
    return inTransaction(this.db, () => {
      const ts = this.ts()
      const recorded = this.faultStop(ts, start, `${CARD_STOPPED}:no-pull-request:${start.dedupe_key}`, detail)
      if (recorded) {
        for (const question of questions)
          openOwnerWait(this.db, ts, this.actor, { need: 'decision', text: `card #${start.card_id} session ${card.session} asks: ${question}`, command: cardDecisionCommand(start.card_id), card: start.card_id })
      }
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
    return this.executor.launch(lease)
  }

  protected override stepLine(step: LaunchStep): string | null {
    if (step.kind === 'started')
      return `${step.taskKey}: started session ${step.card.session} as pid ${step.card.pid} (its own process group) in ${step.card.worktree} on ${step.card.branch} from ${step.card.base}`
    if (step.kind === 'fenced')
      return `${step.taskKey}: the lease moved on or the card is no longer queued; nothing written`
    return super.stepLine(step)
  }
}

export interface LaunchRun {
  busPath: string
  starter: CardStarter
  ladder?: CardStarter
  continuer?: SessionContinuer
  session: string
  pause: (ms: number) => Promise<unknown>
  isolation: IsolationReader
  launchDir: string
  treePr?: string
}

export function runWithdrawLegacy(busPath: string, clock: () => Date): number {
  const db = openBus(busPath)
  try {
    const keys = withdrawLegacyLaunchTasks(db, clock().toISOString())
    for (const key of keys)
      console.log(`${PREFIX}${key}: withdrawn (${LEGACY_REASON}); nothing started`)
    console.log(`${PREFIX}${keys.length} withdrawn`)
    return 0
  }
  finally {
    db.close()
  }
}

export function hasCommitsAhead(card: StartedCard): boolean {
  try {
    return Number(execFileSync('git', ['-C', card.worktree, 'rev-list', '--count', `${card.base}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) > 0
  }
  catch {
    return true
  }
}

export function reportWrittenSince(launchDir: string, start: SessionStart): boolean {
  const since = Date.parse(start.ts)
  return [`report-${start.cardId}.md`, `report-${start.cardId}-brief.md`].some((file) => {
    const report = path.join(launchDir, file)
    return existsSync(report) && statSync(report).mtimeMs >= since
  })
}

export function sessionLeftAResult(launchDir: string): (card: StartedCard, start: SessionStart) => boolean {
  return (card, start) => reportWrittenSince(launchDir, start) || hasCommitsAhead(card)
}

export function handoffWrittenSince(launchDir: string): (start: SessionStart) => boolean {
  return (start) => {
    const report = path.join(launchDir, `report-${start.cardId}.md`)
    return existsSync(report) && statSync(report).mtimeMs >= Date.parse(start.ts) && continuationRefusal(readFileSync(report, 'utf8')) === null
  }
}

export function reportSince(launchDir: string): (start: SessionStart) => string | null {
  return (start) => {
    const report = reportPath(launchDir, String(start.cardId))
    return reportWrittenSince(launchDir, start) && existsSync(report) ? readFileSync(report, 'utf8') : null
  }
}

export function eddiesWarned(card: StartedCard): boolean {
  const journal = eddiesJournalPath(card.worktree)
  return existsSync(journal) && eddiesEvidence(readFileSync(journal, 'utf8'), card.session).warned
}

export function treePrPublisher(treePr: string, launchDir: string, env: NodeJS.ProcessEnv): (card: StartedCard, start: SessionStart) => void {
  return (card, start) => {
    try {
      execFileSync('sh', ['-c', `${treePr} ${start.cardId} ${shellWord(card.worktree)} ${shellWord(reportPath(launchDir, String(start.cardId)))}`], { env: { ...env, ...HTTPS_ORIGIN_ENV }, stdio: 'ignore' })
    }
    catch {}
  }
}

export function reportResultLine(launchDir: string): (start: SessionStart) => string | null {
  return (start) => {
    const report = path.join(launchDir, `report-${start.cardId}.md`)
    if (!reportWrittenSince(launchDir, start) || !existsSync(report))
      return null
    return readFileSync(report, 'utf8').split('\n').find(line => line.startsWith('result: ')) ?? null
  }
}

export async function runLaunchWorker(argv: string[], run: LaunchRun): Promise<number> {
  if (argv.includes(WITHDRAW_LEGACY_FLAG))
    return runWithdrawLegacy(run.busPath, () => new Date())
  let node: LaunchNode | undefined
  const build = (db: DatabaseSync, mode: DetectionMode): LaunchNode => {
    node = new LaunchNode({ db, starter: run.starter, ladder: run.ladder, clock: () => new Date(), session: run.session, mode, env: process.env, isolation: run.isolation, resulted: sessionLeftAResult(run.launchDir), endedWith: reportResultLine(run.launchDir), handedOff: handoffWrittenSince(run.launchDir), reportOf: reportSince(run.launchDir), warned: eddiesWarned, ...(run.treePr === undefined ? {} : { publish: treePrPublisher(run.treePr, run.launchDir, process.env) }), continuer: run.continuer, prompts: promptsDirOf(run.busPath) })
    return node
  }
  const pause = async (ms: number): Promise<unknown> => {
    node?.stopOverdue()
    return run.pause(ms)
  }
  return runNode(argv, 'launch', run.busPath, build, { pause })
}

export const CARD_TEXT_HEADING = 'The card text this session runs on:'

export function continuedOnCardText(task: ShiftTask, bodyOf: CardBodyReader): ShiftTask {
  if (!task.body.startsWith(CONTINUE_PROMPT))
    return task
  const text = bodyOf(task.card.id)
  const parsed = text === null ? null : parseParkingFile(`${task.card.id}.md`, text)
  if (parsed?.kind !== 'parked')
    return task
  return { ...task, body: `${task.body}\n\n${CARD_TEXT_HEADING}\n\n${parsed.parked.task.body}` }
}

export function realStarterPorts(repo: string, env: NodeJS.ProcessEnv, header: string, uuid: () => string, bodyOf: CardBodyReader = () => null, cardSessions: (cardId: number) => string[] = () => [], installed: string | null = installedPackage()): StarterPorts {
  const taskStart = taskStartCommand(installed)
  return {
    read: bodyOf,
    cut: (task) => {
      execFileSync(taskStart.file, [...taskStart.args, task.branch, '--card', task.card.line], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return taskWorktree(worktreeHome(env), String(task.card.id))
    },
    base: worktree => execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    spawnDetached,
    pgidOf: psPgid,
    kill: killQuietly,
    uuid,
    envOf: cardId => ({ ...sessionEnv(env, cardId), ...heartbeatEnv({ cardId, pr: null, head: null, queue: 'launch' }), ...HTTPS_ORIGIN_ENV }),
    prompt: (task, places) => renderPrompt(header, continuedOnCardText(task, bodyOf), places),
    changedPaths: gitChangedPaths,
    readReport: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
    cardSessions,
    readTranscript: (worktree, session) => {
      const file = transcriptFile(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), worktree, session)
      return file !== null && existsSync(file) ? readFileSync(file, 'utf8') : null
    },
    treeFile: readTreeFile,
  }
}

export function readTreeFile(file: string): TreeFile | null {
  try {
    return { content: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs }
  }
  catch {
    return null
  }
}

const CARD_SESSIONS = `
  SELECT json_extract(payload, '$.session') AS session FROM events
  WHERE legacy = 0 AND type IN ('${CARD_STARTED}', '${CARD_ANSWERED}') AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.session') = 'text'
  ORDER BY id
`

export function busCardSessions(busPath: string): (cardId: number) => string[] {
  return (cardId) => {
    if (!existsSync(busPath))
      return []
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      const rows = db.prepare(CARD_SESSIONS).all(cardId) as { session: string }[]
      return [...new Set(rows.map(row => row.session))]
    }
    finally {
      db.close()
    }
  }
}

export function busStarterPorts(busPath: string, repo: string, env: NodeJS.ProcessEnv, header: string, uuid: () => string): StarterPorts {
  return realStarterPorts(repo, env, header, uuid, busCardBodies(busPath), busCardSessions(busPath))
}

export function handoffLadderSteps(handoffDir: string, repo: string, env: NodeJS.ProcessEnv, busPath: string): LadderSteps {
  const readIfThere = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null
  return {
    stepOf: task => ladderStep({ journal: ghostLinesText(busPath), brief: readIfThere(briefPathOf(handoffDir, task.card)) }, task.card),
    tree: (task) => {
      const tree = taskWorktree(worktreeHome(env), String(task.card.id))
      return existsSync(tree) ? tree : null
    },
    brief: task => briefPathOf(handoffDir, task.card),
    tasksFile: (task) => {
      const file = tasksFilePathOf(handoffDir, task.card)
      const text = tasksFileText(task.card, { repo, handoffDir, brief: briefPathOf(handoffDir, task.card) })
      if (existsSync(file)) {
        if (readFileSync(file, 'utf8') !== text)
          throw new Error(`${file} exists and holds another tasks file; nothing launched`)
        return file
      }
      mkdirSync(handoffDir, { recursive: true })
      writeFileSync(file, text)
      return file
    },
    body: (task, step) => {
      const brief = briefPathOf(handoffDir, task.card)
      return step === 'brief' ? briefBody(task.card, brief) : reviewBody(task.card, brief, reviewOf(task.touches))
    },
  }
}

export function launchIsolationCommand(claude: string): string[] {
  return commandWords(cardCommand(claude))
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const env = process.env
  const places = launchPlaces(os.homedir(), process.cwd(), busPath)
  const header = readFileSync(HEADER_FILE, 'utf8')
  const ports = busStarterPorts(busPath, process.cwd(), env, header, randomUUID)
  const starter = new ShiftCardStarter(places, ports)
  const ladder = new LadderCardStarter({ ...places, repo: process.cwd() }, ports, handoffLadderSteps(handoffDir(env), process.cwd(), env, busPath))
  return runLaunchWorker(process.argv.slice(2), { busPath, starter, ladder, continuer: starter, session: randomUUID(), pause: sleep, launchDir: places.launchDir, treePr: places.treePr, isolation: realIsolationReader(env, process.cwd(), launchIsolationCommand(places.claude)) })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
