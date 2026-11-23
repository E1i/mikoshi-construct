import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { isMainThread, workerData } from 'node:worker_threads'
import { BOARD_STALE_TICKS, openBoardBeatWriter, recordBoardBeat } from '../../core/db.js'
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

export function boardBeatUnrecordedLine(error: unknown): string {
  return `${BOARD_TIMER_PREFIX}recording the board timer's beat failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}; miko watch reads the board as stale once ${BOARD_STALE_TICKS} beats are missing`
}

export function boardBeatRecorder(db: DatabaseSync, clock: () => Date = () => new Date()): () => void {
  return () => {
    try {
      recordBoardBeat(db, clock().toISOString())
    }
    catch (error) {
      console.error(boardBeatUnrecordedLine(error))
    }
  }
}

export async function runBoardTimer(busPath: string, periodMs: number, running: () => boolean = () => true, log: (line: string) => void = console.log): Promise<void> {
  const beats = openBoardBeatWriter(busPath)
  const board = readOnlyBoardProjection(busPath, periodMs, boardBeatRecorder(beats))
  try {
    const timer = new BoardTimer(board.projection.project)
    while (running()) {
      log(boardTimerLine(timer.run()))
      await sleep(periodMs)
    }
  }
  finally {
    board.close()
    beats.close()
  }
}

const started = workerData as Record<string, unknown> | null
if (!isMainThread && typeof started?.[BOARD_TIMER_BUS_PATH] === 'string')
  await runBoardTimer(started[BOARD_TIMER_BUS_PATH], Number(started[BOARD_TIMER_PERIOD]))
