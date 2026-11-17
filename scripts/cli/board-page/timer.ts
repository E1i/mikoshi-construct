import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { BUSY_TIMEOUT_MS } from '../../core/db.js'
import { openDatabase } from '../../core/sqlite.js'
import { BOARD_FILE } from '../../window/board.js'
import { BOARD_DATA_FILE, boardProjection } from '../board-page.js'

export const BOARD_PERIOD_MS = 10_000
export const PREFIX = '[bus:board-timer] '
const WORKER_BUS_PATH = 'boardTimerBusPath'
const WORKER_PERIOD = 'boardTimerPeriodMs'

export class BoardTimer {
  constructor(private readonly project: (now: Date) => void, private readonly clock: () => Date = () => new Date(), private readonly elapsedMs: () => number = () => performance.now()) {}

  run(): number {
    const started = this.elapsedMs()
    this.project(this.clock())
    return this.elapsedMs() - started
  }
}

export function boardTimerLine(ms: number): string {
  return `${PREFIX}board projected in ${(ms / 1000).toFixed(2)} s`
}

export async function runBoardTimer(busPath: string, periodMs: number, running: () => boolean = () => true, log: (line: string) => void = console.log): Promise<void> {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const timer = new BoardTimer(boardProjection(db, busPath, periodMs).project)
    while (running()) {
      log(boardTimerLine(timer.run()))
      await sleep(periodMs)
    }
  }
  finally {
    db.close()
  }
}

export interface StartedBoardTimer {
  file: string
  dataFile: string
  stop: () => Promise<void>
}

export function startBoardTimer(busPath: string, periodMs: number = BOARD_PERIOD_MS): StartedBoardTimer {
  const worker = new Worker(new URL(import.meta.url), { workerData: { [WORKER_BUS_PATH]: busPath, [WORKER_PERIOD]: periodMs } })
  worker.on('error', error => console.error(`${PREFIX}${error.message.split('\n')[0]}`))
  return {
    file: path.join(path.dirname(busPath), BOARD_FILE),
    dataFile: path.join(path.dirname(busPath), BOARD_DATA_FILE),
    stop: async () => {
      await worker.terminate()
    },
  }
}

const started = workerData as Record<string, unknown> | null
if (!isMainThread && typeof started?.[WORKER_BUS_PATH] === 'string')
  await runBoardTimer(started[WORKER_BUS_PATH], Number(started[WORKER_PERIOD]))
