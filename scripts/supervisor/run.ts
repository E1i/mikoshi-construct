import type { DatabaseSync } from 'node:sqlite'
import type { GitHubPost } from '../core/pr-status.js'
import type { Derived } from '../core/queue.js'
import type { Projections, ReduceCount } from '../core/reducer.js'
import type { GitHub } from '../ports/github.js'
import type { Poll } from '../ports/netwatch.js'
import type { BgResult, ProcessList } from './bg.js'
import type { StartedReducerLoop } from './reducer-loop.js'
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { BOARD_PERIOD_MS, startBoardTimer } from '../cli/board-page.js'
import { busDirOf } from '../core/bus-path.js'
import { CHECK_MS, TICK_MS } from '../core/cadence.js'
import { closedWaitIds } from '../core/card-readings.js'
import { appendEvent, BOARD_TIMER_PROCESS, defaultBusPath, inTransaction, openBus, openBusWait } from '../core/db.js'
import { WINDOW_REQUEST, WORKER_DOWN } from '../core/events.js'
import { DATABASE_LOCKED, isDatabaseLocked } from '../core/node.js'
import { setStepStatuses, STATUS_CONTEXT, STATUS_OFF_FILE, statusesSwitchedOff, statusFailureLine, statusLine } from '../core/pr-status.js'
import { QUEUE_ACTOR } from '../core/queue.js'
import { ownerChannelOfBus } from '../owner/channel.js'
import { ghApi, ghApiPost } from '../ports/github.js'
import { NetWatch, pollLine } from '../ports/netwatch.js'
import { OsProcessTable } from '../ports/process-table.js'
import { realRequestTools } from '../window/window-request-tools.js'
import { WindowRequests } from '../window/window-requests.js'
import { alive, BUS_RUN_MARKERS, instancesOf, processBeatsOn, psList, RUN_SCRIPT } from './bg.js'
import { closeWaitsOfEndedCards } from './card-waits.js'
import { busProjections, cardTransitions, composeBus, deadEndParts, deriveQueuesOfTheBus, gateRunSpoolPlaces, openComposedBus, recordOwnStart, requiredCheckAt } from './composition.js'
import { DeadEnds } from './dead-ends.js'
import { GateRunSpool } from './gate-run-spool.js'
import { sessionLifeIn } from './recorded-worker.js'
import { REDUCER_PERIOD_MS, REDUCER_PREFIX, ReducerPass, startReducerLoop } from './reducer-loop.js'
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
    return openBusWait(db, closedWaitIds(db), new Date(nowMs).toISOString(), QUEUE_ACTOR, { need: 'command', text: question, command: `rm ${lock}` })
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

export const TICK_STEPS = ['NetWatch.poll', 'deriveQueues', 'setStepStatuses', 'StalledSessions', 'GateRunSpool', 'DeadEnds'] as const

export const INLINE_REDUCER_STEP = 'reducer pass'

export type TickStep = typeof TICK_STEPS[number] | typeof INLINE_REDUCER_STEP

export interface StepTiming {
  step: TickStep
  ms: number
}

export interface Tick {
  poll: Poll
  reduced: ReduceCount | null
  derived: Derived | null
  spooled: string[]
  steps: StepTiming[]
}

export class BusTick {
  lastSteps: readonly StepTiming[] = []
  private readonly inlineReducer: ReducerPass | null

  constructor(private readonly db: DatabaseSync, reducedInline: Projections | ReducerPass | null, private readonly netWatch: NetWatch, private readonly clock: () => Date, requests: () => void = () => {}, private readonly statuses: () => void = () => {}, private readonly stalled: () => void = () => {}, private readonly spools: () => string[] = () => [], private readonly elapsedMs: () => number = () => performance.now(), private readonly deadEnds: () => void = () => {}) {
    composeBus(db)
    this.inlineReducer = reducedInline === null || reducedInline instanceof ReducerPass ? reducedInline : new ReducerPass(db, reducedInline, clock, requests)
  }

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
      return { poll, reduced: null, derived: null, spooled: [], steps }
    const inline = this.inlineReducer
    const reduced = inline === null ? null : timed(INLINE_REDUCER_STEP, () => inline.run())
    const ts = this.clock().toISOString()
    const derived = timed('deriveQueues', () => deriveQueuesOfTheBus(this.db, ts))
    timed('setStepStatuses', this.statuses)
    timed('StalledSessions', this.stalled)
    const spooled = timed('GateRunSpool', this.spools)
    timed('DeadEnds', this.deadEnds)
    return { poll, reduced, derived, spooled, steps }
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
  return [...lines, ...tick.spooled]
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

export const QUIET_REDUCED_MS = TICK_MS

export function composeReducerPass(db: DatabaseSync, busPath: string, clock: () => Date, home: string, repo: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log, quietMs: number = QUIET_REDUCED_MS): ReducerPass {
  composeBus(db)
  const projections = busProjections()
  const requests = new WindowRequests(db, clock, realRequestTools(db, busPath, repo, env, projections), ownerChannelOfBus(home, busPath))
  const answer = (): void => {
    for (const outcome of requests.run())
      log(`${REDUCER_PREFIX}${WINDOW_REQUEST} ${outcome.request} ${outcome.kind}: ${outcome.detail}`)
  }
  return new ReducerPass(db, projections, clock, answer, quietMs)
}

export type ReducerPlacement = 'inline' | 'own-thread'

export function composeBusTick(db: DatabaseSync, busPath: string, gitHub: GitHub, post: GitHubPost, clock: () => Date, home: string, spools: () => string[] = () => [], placement: ReducerPlacement = 'inline'): ComposedTick {
  const reducer = placement === 'inline' ? composeReducerPass(db, busPath, clock, home, process.cwd(), process.env, console.log, 0) : null
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
  const silent = new StalledSessions(db, clock, { cards: cardTransitions(), lifeOf: sessionLifeIn(table), prefix: PREFIX })
  const stalled = (): void => {
    for (const line of silent.step())
      console.log(line)
  }
  const ends = new DeadEnds(db, clock, deadEndParts(db))
  const deadEnds = (): void => {
    for (const line of ends.step())
      console.log(`${PREFIX}${line}`)
  }
  return { busTick: new BusTick(db, reducer, new NetWatch(db, gitHub, clock, RUN_SCRIPT, () => requiredCheckAt()), clock, () => {}, statuses, stalled, spools, () => performance.now(), deadEnds) }
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
  const db = openComposedBus(busPath)
  recordOwnStart(db, 'run')
  const closed = startBus(db, () => new Date())
  if (closed.length > 0)
    console.log(`${PREFIX}closed the owner waits of ended cards: ${closed.join(', ')}`)
  const spool = new GateRunSpool(db, gateRunSpoolPlaces(process.env, busPath, process.cwd()), PREFIX)
  const { busTick } = composeBusTick(db, busPath, ghApi(process.cwd()), ghApiPost(process.cwd()), () => new Date(), os.homedir(), () => spool.step(), 'own-thread')
  const reducer = startReducerLoop(busPath, os.homedir())
  const board = startBoardThread(db, busPath)
  console.log(`${PREFIX}${busPath}, shadow mode: the reducer with the window requests every ${REDUCER_PERIOD_MS / 1000} s on its own connection in its own thread; NetWatch, the queues and the ${STATUS_CONTEXT} status check on each open PR head unless ${STATUS_OFF_FILE} sits beside it every ${TICK_MS / 1000} s; ${board.file} with ${board.dataFile} every ${BOARD_PERIOD_MS / 1000} s on a read-only connection in its own thread; no workers`)
  return superviseUntilEnd(() => tickWhileReducing(busTick, reducer), bothThreads(reducer, board), () => db.close())
}

type BoardTimerSpawn = NonNullable<Parameters<typeof startBoardTimer>[2]>
type StartedBoardTimer = ReturnType<typeof startBoardTimer>

export const BOARD_THREAD = BOARD_TIMER_PROCESS
export const BOARD_RESTART_CAP_MS = 300_000
const PERIODS_THAT_CLEAR_THE_FAILURES = 2

export interface BoardThreadDown {
  worker: string
  cause: string
  failures: number
  nextAttemptAt: Date
}

export function restartDelayMs(periodMs: number, failures: number): number {
  return Math.min(periodMs * 2 ** Math.max(0, failures - 1), Math.max(periodMs, BOARD_RESTART_CAP_MS))
}

export function boardThreadEndedLine(cause: string, restartInMs: number): string {
  return `${PREFIX}the board thread ended (${cause}), so the board page stops being written; bus:run records worker.down and starts the thread again in ${(restartInMs / 1000).toFixed(1)} s`
}

export function boardThreadDownUnrecordedLine(error: unknown): string {
  return `${PREFIX}recording worker.down for ${BOARD_THREAD} failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}; the thread is started again all the same`
}

class KeptBoardThread {
  private thread: StartedBoardTimer | null = null
  private failures = 0
  private startedMs = 0
  private restart: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly busPath: string, private readonly periodMs: number, private readonly spawn: BoardTimerSpawn | undefined, private readonly down: (down: BoardThreadDown) => void, private readonly now: () => number) {}

  start(): StartedBoardTimer {
    this.startedMs = this.now()
    const thread: StartedBoardTimer = startBoardTimer(this.busPath, this.periodMs, this.spawn, cause => this.ended(thread, cause))
    this.thread = thread
    return thread
  }

  async stop(): Promise<void> {
    if (this.restart !== null)
      clearTimeout(this.restart)
    this.restart = null
    const thread = this.thread
    this.thread = null
    if (thread !== null)
      await thread.stop()
  }

  private ended(thread: StartedBoardTimer, cause: string): void {
    if (thread !== this.thread)
      return
    this.thread = null
    this.failures = this.now() - this.startedMs >= this.periodMs * PERIODS_THAT_CLEAR_THE_FAILURES ? 1 : this.failures + 1
    const delay = restartDelayMs(this.periodMs, this.failures)
    console.error(boardThreadEndedLine(cause, delay))
    try {
      this.down({ worker: BOARD_THREAD, cause, failures: this.failures, nextAttemptAt: new Date(this.now() + delay) })
    }
    catch (error) {
      console.error(boardThreadDownUnrecordedLine(error))
    }
    this.restart = setTimeout(() => {
      this.restart = null
      this.start()
    }, delay)
  }
}

export function keepBoardThread(busPath: string, periodMs: number = BOARD_PERIOD_MS, spawn?: BoardTimerSpawn, down: (down: BoardThreadDown) => void = () => {}, now: () => number = Date.now): StartedBoardTimer {
  const kept = new KeptBoardThread(busPath, periodMs, spawn, down, now)
  const first = kept.start()
  return { file: first.file, dataFile: first.dataFile, stop: async () => kept.stop() }
}

export function boardThreadDownRecorder(db: DatabaseSync): (down: BoardThreadDown) => void {
  return (down) => {
    const ts = new Date().toISOString()
    appendEvent(db, { ts, type: WORKER_DOWN, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${WORKER_DOWN}:${down.worker}:${ts}`, payload: { worker: down.worker, failures: down.failures, cause: down.cause, next_attempt_at: down.nextAttemptAt.toISOString() }, legacy: false })
  }
}

export function startBoardThread(db: DatabaseSync, busPath: string, periodMs: number = BOARD_PERIOD_MS, spawn?: BoardTimerSpawn): StartedBoardTimer {
  return keepBoardThread(busPath, periodMs, spawn, boardThreadDownRecorder(db))
}

export function tickWhileReducing(busTick: BusTick, reducer: Pick<StartedReducerLoop, 'failure'>): string[] {
  const failed = reducer.failure()
  if (failed !== null)
    throw new Error(`${PREFIX}the reducer thread ended (${failed.message.split('\n')[0]}), so bus:run ends with it`)
  return tickOrLocked(busTick)
}

function bothThreads(reducer: StartedReducerLoop, board: { stop: () => Promise<void> }): { stop: () => Promise<void> } {
  return {
    stop: async () => {
      await reducer.stop()
      await board.stop()
    },
  }
}

export async function superviseUntilEnd(tick: () => string[], board: { stop: () => Promise<void> }, close: () => void, pause: () => Promise<unknown> = async () => sleep(CHECK_MS)): Promise<never> {
  try {
    for (;;) {
      const lines = tick()
      if (lines.length > 0)
        console.log(lines.join('\n'))
      await pause()
    }
  }
  finally {
    await board.stop()
    close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
