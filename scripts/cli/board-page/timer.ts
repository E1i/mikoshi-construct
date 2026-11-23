import type { BoardBeatWriter } from '../board-page.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { isMainThread, workerData } from 'node:worker_threads'
import { BOARD_TIMER_BUS_PATH, BOARD_TIMER_PERIOD, BOARD_TIMER_PREFIX, readOnlyBoardProjection } from '../board-page.js'

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

export function boardBeatUnrecordedLine(error: unknown, staleTicks: number): string {
  return `${BOARD_TIMER_PREFIX}recording the board timer's beat failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}; miko watch reads the board as stale once ${staleTicks} beats are missing`
}

export function boardBeatRecorder(clock: () => Date = () => new Date()): (writer: BoardBeatWriter) => () => void {
  return writer => () => {
    try {
      writer.record(clock().toISOString())
    }
    catch (error) {
      console.error(boardBeatUnrecordedLine(error, writer.staleTicks))
    }
  }
}

export async function runBoardTimer(busPath: string, periodMs: number, running: () => boolean = () => true, log: (line: string) => void = console.log): Promise<void> {
  const board = readOnlyBoardProjection(busPath, periodMs, boardBeatRecorder())
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

const started = workerData as Record<string, unknown> | null
if (!isMainThread && typeof started?.[BOARD_TIMER_BUS_PATH] === 'string')
  await runBoardTimer(started[BOARD_TIMER_BUS_PATH], Number(started[BOARD_TIMER_PERIOD]))
