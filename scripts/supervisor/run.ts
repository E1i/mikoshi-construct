import type { DatabaseSync } from 'node:sqlite'
import type { Derived } from '../core/queue.js'
import type { Projections, ReduceCount } from '../core/reducer.js'
import type { GitHub } from '../ports/github.js'
import type { Poll } from '../ports/netwatch.js'
import type { GitHubPost } from '../ports/pr-status.js'
import type { BgResult, ProcessList } from './bg.js'
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { BOARD_PERIOD_MS, startBoardTimer } from '../cli/board-page/timer.js'
import { busDirOf } from '../core/bus-path.js'
import { appendEvent, defaultBusPath, inTransaction, openBus, openBusWait } from '../core/db.js'
import { REDUCED, WINDOW_REQUEST } from '../core/events.js'
import { DATABASE_LOCKED, isDatabaseLocked } from '../core/node.js'
import { deriveQueues, QUEUE_ACTOR } from '../core/queue.js'
import { closeWaitsOfEndedCards, reduce } from '../core/reducer.js'
import { ownerChannelOfBus } from '../owner/channel.js'
import { decisionsIntakeOfBus } from '../policy/decisions/import.js'
import { ghApi } from '../ports/github.js'
import { CHECK_MS, NetWatch, pollLine, TICK_MS } from '../ports/netwatch.js'
import { ghApiPost, setStepStatuses, STATUS_CONTEXT, STATUS_OFF_FILE, statusesSwitchedOff, statusFailureLine, statusLine } from '../ports/pr-status.js'
import { OsProcessTable } from '../ports/process-table.js'
import { realRequestTools } from '../window/window-request-tools.js'
import { WindowRequests } from '../window/window-requests.js'
import { alive, BUS_RUN_MARKERS, instancesOf, processBeatsOn, psList, RUN_SCRIPT } from './bg.js'
import { busProjections, recordOwnStart } from './composition.js'
import { sessionLifeIn } from './recorded-worker.js'
import { StalledSessions } from './stalled-sessions.js'
import { stampLogOutput } from './stamp.js'

export const PREFIX = '[bus:run] '
export const RUN_LOCK = 'bus-run.lock'

function lockHolder(lock: string): number | null {
  try {
    const holder = Number(readFileSync(lock, 'utf8').trim())
    return Number.isInteger(holder) && holder > 0 ? holder : null
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

type HolderReading = { kind: 'serves' } | { kind: 'gone' } | { kind: 'beats', why: string } | { kind: 'unproven', question: string }

function holderReading(lock: string, holder: number, processes: ProcessList, busPath: string, nowMs: number): HolderReading {
  let listed: ReturnType<ProcessList>
  try {
    listed = processes()
  }
  catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return processBeatsOn(busPath, RUN_SCRIPT, nowMs) ? { kind: 'beats', why } : { kind: 'unproven', question: unprovenHolderQuestion(lock, holder, busPath, why) }
  }
  return instancesOf(listed, BUS_RUN_MARKERS, busPath).some(candidate => candidate.pid === holder) ? { kind: 'serves' } : { kind: 'gone' }
}

function unprovenHolderQuestion(lock: string, holder: number, busPath: string, why: string): string {
  return `pid ${holder} holds ${lock} for ${busPath}; the process table could not be read (${why}) and no bus:run heartbeat on this bus is recent, so nothing proves the holder gone (a signal 0 to pid ${holder} ${alive(holder) ? 'is answered' : 'finds no process'}). A second bus:run on one bus.db is not allowed: remove ${lock} only once pid ${holder} is no bus:run`
}

function askOwnerOfUnprovenHolder(busPath: string, question: string, lock: string, nowMs: number): string | null {
  if (!existsSync(busPath))
    return null
  const db = openBus(busPath)
  try {
    return openBusWait(db, new Date(nowMs).toISOString(), QUEUE_ACTOR, { need: 'command', text: question, command: `rm ${lock}` })
  }
  finally {
    db.close()
  }
}

function refusedRun(line: string): BgResult {
  return { stdout: [], stderr: [`${PREFIX}${line}`], exitCode: 1 }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

function linkLock(lock: string, self: number): boolean {
  const written = `${lock}.${self}`
  writeFileSync(written, `${self}\n`)
  try {
    linkSync(written, lock)
    return true
  }
  catch (error) {
    if (!isErrorCode(error, 'EEXIST'))
      throw error
    return false
  }
  finally {
    rmSync(written, { force: true })
  }
}

export function lockBreakerOf(lock: string): string {
  return `${lock}.break`
}

function removeStaleLock(lock: string, staleHolder: number | null, self: number): BgResult | null {
  const breaker = lockBreakerOf(lock)
  try {
    writeFileSync(breaker, `${self}\n`, { flag: 'wx' })
  }
  catch (error) {
    if (!isErrorCode(error, 'EEXIST'))
      throw error
    return refusedRun(`${breaker} is held: another bus:run is removing a stale ${RUN_LOCK}, so this one exits and starts nothing; remove ${breaker} if no bus:run is starting`)
  }
  try {
    if (lockHolder(lock) === staleHolder)
      rmSync(lock, { force: true })
    return null
  }
  finally {
    rmSync(breaker, { force: true })
  }
}

export function holdRunLock(busPath: string, processes: ProcessList, self: number = process.pid, nowMs: number = Date.now()): BgResult {
  const busDir = busDirOf(busPath)
  const lock = path.join(busDir, RUN_LOCK)
  mkdirSync(busDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    if (linkLock(lock, self))
      return { stdout: [], stderr: [], exitCode: 0 }
    const holder = lockHolder(lock)
    const reading = holder === null || holder === self ? null : holderReading(lock, holder, processes, busPath, nowMs)
    if (reading?.kind === 'serves')
      return refusedRun(`another bus:run, pid ${holder}, holds ${lock} for ${busPath}; one bus:run serves one bus, so this one exits and starts nothing`)
    if (reading?.kind === 'beats')
      return refusedRun(`pid ${holder} holds ${lock} for ${busPath}, the process table could not be read (${reading.why}) and a bus:run heartbeat on this bus is recent; this one exits and starts nothing`)
    if (reading?.kind === 'unproven') {
      const wait = askOwnerOfUnprovenHolder(busPath, reading.question, lock, nowMs)
      return refusedRun(`${reading.question}; this one exits, takes no lock and starts nothing${wait === null ? '' : `, owner wait ${wait}`}`)
    }
    const refused = removeStaleLock(lock, holder, self)
    if (refused !== null)
      return refused
  }
  return refusedRun(`${lock} was taken again while this bus:run removed a stale one; this one exits and starts nothing`)
}

export const TICK_STEPS = ['NetWatch.poll', 'intake', 'reduce', 'WindowRequests', 'second reduce', 'deriveQueues', 'setStepStatuses', 'StalledSessions'] as const

export type TickStep = typeof TICK_STEPS[number]

export interface StepTiming {
  step: TickStep
  ms: number
}

export interface Tick {
  poll: Poll
  reduced: ReduceCount | null
  derived: Derived | null
  steps: StepTiming[]
}

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

export class BusTick {
  lastSteps: readonly StepTiming[] = []

  constructor(private readonly db: DatabaseSync, private readonly projections: Projections, private readonly netWatch: NetWatch, private readonly clock: () => Date, private readonly intake: () => void = () => {}, private readonly requests: () => void = () => {}, private readonly statuses: () => void = () => {}, private readonly stalled: () => void = () => {}, private readonly elapsedMs: () => number = () => performance.now()) {}

  run(): Tick | null {
    const steps: StepTiming[] = []
    this.lastSteps = steps
    const timed = <T>(step: TickStep, work: () => T): T => {
      const started = this.elapsedMs()
      try {
        return work()
      }
      finally {
        steps.push({ step, ms: this.elapsedMs() - started })
      }
    }
    const poll = timed('NetWatch.poll', () => this.netWatch.poll())
    if (poll === null)
      return null
    if (poll.kind !== 'ticked')
      return { poll, reduced: null, derived: null, steps }
    timed('intake', this.intake)
    const beforeRequests = timed('reduce', () => reduce(this.db, 'pending', this.projections))
    timed('WindowRequests', this.requests)
    const ts = this.clock().toISOString()
    const reduced = timed('second reduce', () => {
      const through = lastEventId(this.db)
      const afterRequests = reduce(this.db, 'pending', this.projections)
      const both = { applied: beforeRequests.applied + afterRequests.applied, rejected: beforeRequests.rejected + afterRequests.rejected }
      appendEvent(this.db, { ts, type: REDUCED, actor: 'reducer', cardId: null, pr: null, head: null, dedupeKey: `${REDUCED}:${ts}`, payload: { through_event_id: through, ...both }, legacy: false })
      return both
    })
    const derived = timed('deriveQueues', () => deriveQueues(this.db, ts))
    timed('setStepStatuses', this.statuses)
    timed('StalledSessions', this.stalled)
    return { poll, reduced, derived, steps }
  }
}

export function stepTimingLine(steps: readonly StepTiming[]): string {
  return `${PREFIX}tick steps: ${steps.map(each => `${each.step} ${(each.ms / 1000).toFixed(2)} s`).join(', ')}`
}

export function tickLines(tick: Tick): string[] {
  const lines = [pollLine(tick.poll), stepTimingLine(tick.steps)]
  if (tick.reduced !== null)
    lines.push(`${PREFIX}reduced: applied ${tick.reduced.applied}, rejected ${tick.reduced.rejected}`)
  if (tick.derived !== null && tick.derived.superseded.length + tick.derived.queued.length > 0)
    lines.push(`${PREFIX}queues: superseded ${tick.derived.superseded.join(', ') || '—'}; queued ${tick.derived.queued.join(', ') || '—'}`)
  return lines
}

export function tickOrLocked(busTick: BusTick): string[] {
  try {
    const tick = busTick.run()
    return tick === null ? [] : tickLines(tick)
  }
  catch (error) {
    if (!isDatabaseLocked(error))
      throw error
    return [`${PREFIX}the tick hit ${DATABASE_LOCKED}; it is retried in ${CHECK_MS / 1000} s, and bus:run stays up`, stepTimingLine(busTick.lastSteps)]
  }
}

export interface ComposedTick {
  busTick: BusTick
}

export function composeBusTick(db: DatabaseSync, busPath: string, gitHub: GitHub, post: GitHubPost, clock: () => Date, home: string): ComposedTick {
  const projections = busProjections()
  const requests = new WindowRequests(db, clock, realRequestTools(db, busPath, process.cwd(), process.env, projections), ownerChannelOfBus(home, busPath))
  const answer = (): void => {
    for (const outcome of requests.run())
      console.log(`${PREFIX}${WINDOW_REQUEST} ${outcome.request} ${outcome.kind}: ${outcome.detail}`)
  }
  const statuses = (): void => {
    if (statusesSwitchedOff(busPath))
      return
    try {
      for (const status of setStepStatuses(db, post, clock))
        console.log(statusLine(status))
    }
    catch (error) {
      console.log(statusFailureLine(error))
    }
  }
  const table = new OsProcessTable()
  const silent = new StalledSessions(db, clock, { lifeOf: sessionLifeIn(table), prefix: PREFIX })
  const stalled = (): void => {
    for (const line of silent.step())
      console.log(line)
  }
  return { busTick: new BusTick(db, projections, new NetWatch(db, gitHub, clock), clock, decisionsIntakeOfBus(db, busPath, clock), answer, statuses, stalled) }
}

export function startBus(db: DatabaseSync, clock: () => Date): string[] {
  return inTransaction(db, () => closeWaitsOfEndedCards(db, clock().toISOString()))
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const lock = holdRunLock(busPath, psList())
  if (lock.exitCode !== 0) {
    console.error(lock.stderr.join('\n'))
    return lock.exitCode
  }
  const db = openBus(busPath)
  recordOwnStart(db, 'run')
  const closed = startBus(db, () => new Date())
  if (closed.length > 0)
    console.log(`${PREFIX}closed the owner waits of ended cards: ${closed.join(', ')}`)
  const { busTick } = composeBusTick(db, busPath, ghApi(process.cwd()), ghApiPost(process.cwd()), () => new Date(), os.homedir())
  const board = startBoardTimer(busPath)
  console.log(`${PREFIX}${busPath}, shadow mode: NetWatch, the owner decisions import, the window requests, the reducer, the queues and the ${STATUS_CONTEXT} status check on each open PR head unless ${STATUS_OFF_FILE} sits beside it every ${TICK_MS / 1000} s; ${board.file} with ${board.dataFile} every ${BOARD_PERIOD_MS / 1000} s on a read-only connection in its own thread; no workers`)
  try {
    for (;;) {
      const lines = tickOrLocked(busTick)
      if (lines.length > 0)
        console.log(lines.join('\n'))
      await sleep(CHECK_MS)
    }
  }
  finally {
    await board.stop()
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
