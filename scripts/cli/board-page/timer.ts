import type { BoardProjection } from '../board-page.js'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { builtEntry } from '../../core/built-entry.js'
import { BUSY_TIMEOUT_MS } from '../../core/db.js'
import { openDatabase } from '../../core/sqlite.js'
import { BOARD_FILE } from '../../window/board.js'
import { BOARD_DATA_FILE, boardProjection } from '../board-page.js'

export const BOARD_PERIOD_MS = 10_000
export const BOARD_TIMER_PREFIX = '[bus:board-timer] '
export const BOARD_TIMER_BUS_PATH = 'boardTimerBusPath'
export const BOARD_TIMER_PERIOD = 'boardTimerPeriodMs'
export const BOARD_THREAD = 'bus:board-timer'
export const BOARD_RESTART_CAP_MS = 300_000
const PERIODS_THAT_CLEAR_THE_FAILURES = 2
const BOARD_TIMER_ENTRY = builtEntry(new URL('./timer.ts', import.meta.url), import.meta.url).url

export interface ReadOnlyBoard {
  projection: BoardProjection
  close: () => void
}

export function readOnlyBoardProjection(busPath: string, periodMs: number): ReadOnlyBoard {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  return { projection: boardProjection(db, busPath, periodMs), close: () => db.close() }
}

export class BoardTimer {
  constructor(private readonly project: (now: Date) => void, private readonly clock: () => Date = () => new Date(), private readonly elapsedMs: () => number = () => performance.now()) {}

  run(): number {
    const started = this.elapsedMs()
    this.project(this.clock())
    return this.elapsedMs() - started
  }
}

export function boardTimerLine(ms: number): string {
  return `${BOARD_TIMER_PREFIX}board projected in ${(ms / 1000).toFixed(2)} s`
}

export async function runBoardTimer(busPath: string, periodMs: number, running: () => boolean = () => true, log: (line: string) => void = console.log): Promise<void> {
  const board = readOnlyBoardProjection(busPath, periodMs)
  try {
    const timer = new BoardTimer(board.projection.project)
    while (running()) {
      log(boardTimerLine(timer.run()))
      await sleep(periodMs)
    }
  }
  finally {
    board.close()
  }
}

export interface BoardThread {
  on: ((event: 'error', listener: (error: Error) => void) => unknown) & ((event: 'exit', listener: (code: number) => void) => unknown)
  terminate: () => Promise<unknown>
}

export type BoardTimerSpawn = (entry: URL, workerData: Record<string, unknown>) => BoardThread

export interface BoardThreadDown {
  worker: string
  cause: string
  failures: number
  nextAttemptAt: Date
}

export interface StartedBoardTimer {
  file: string
  dataFile: string
  stop: () => Promise<void>
}

function firstLine(text: string): string {
  return text.split('\n')[0]!
}

export function restartDelayMs(periodMs: number, failures: number): number {
  return Math.min(periodMs * 2 ** Math.max(0, failures - 1), Math.max(periodMs, BOARD_RESTART_CAP_MS))
}

export function boardThreadEndedLine(cause: string, restartInMs: number): string {
  return `${BOARD_TIMER_PREFIX}the board thread ended (${cause}), so board.html stops being written; bus:run records worker.down and starts the thread again in ${(restartInMs / 1000).toFixed(1)} s`
}

export function boardThreadDownUnrecordedLine(error: unknown): string {
  return `${BOARD_TIMER_PREFIX}recording worker.down for ${BOARD_THREAD} failed: ${firstLine(error instanceof Error ? error.message : String(error))}; the thread is started again all the same`
}

class KeptBoardThread {
  private thread: BoardThread | null = null
  private failures = 0
  private startedMs = 0
  private lastError: string | null = null
  private restart: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly busPath: string, private readonly periodMs: number, private readonly spawn: BoardTimerSpawn, private readonly down: (down: BoardThreadDown) => void, private readonly now: () => number) {}

  start(): void {
    this.startedMs = this.now()
    this.lastError = null
    const thread = this.spawn(BOARD_TIMER_ENTRY, { [BOARD_TIMER_BUS_PATH]: this.busPath, [BOARD_TIMER_PERIOD]: this.periodMs })
    this.thread = thread
    thread.on('error', (error) => {
      this.lastError = firstLine(error.message)
      console.error(`${BOARD_TIMER_PREFIX}${this.lastError}`)
    })
    thread.on('exit', code => this.ended(thread, code))
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.restart !== null)
      clearTimeout(this.restart)
    this.restart = null
    const thread = this.thread
    this.thread = null
    if (thread !== null)
      await thread.terminate()
  }

  private ended(thread: BoardThread, code: number): void {
    if (this.stopped || thread !== this.thread)
      return
    this.thread = null
    const lived = this.now() - this.startedMs
    this.failures = lived >= this.periodMs * PERIODS_THAT_CLEAR_THE_FAILURES ? 1 : this.failures + 1
    const cause = this.lastError ?? `exit code ${code}`
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
      if (!this.stopped)
        this.start()
    }, delay)
  }
}

export function startBoardTimer(busPath: string, periodMs: number = BOARD_PERIOD_MS, spawn: BoardTimerSpawn = (entry, workerData) => new Worker(entry, { workerData }), down: (down: BoardThreadDown) => void = () => {}, now: () => number = Date.now): StartedBoardTimer {
  const kept = new KeptBoardThread(busPath, periodMs, spawn, down, now)
  kept.start()
  return {
    file: path.join(path.dirname(busPath), BOARD_FILE),
    dataFile: path.join(path.dirname(busPath), BOARD_DATA_FILE),
    stop: async () => kept.stop(),
  }
}

const started = workerData as Record<string, unknown> | null
if (!isMainThread && typeof started?.[BOARD_TIMER_BUS_PATH] === 'string')
  await runBoardTimer(started[BOARD_TIMER_BUS_PATH], Number(started[BOARD_TIMER_PERIOD]))
