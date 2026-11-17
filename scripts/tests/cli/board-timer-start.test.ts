import type { BoardTimerSpawn } from '../../cli/board-page.js'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TIMER_BUS_PATH, BOARD_TIMER_PERIOD, BOARD_TIMER_PREFIX, startBoardTimer } from '../../cli/board-page.js'
import { superviseUntilEnd } from '../../supervisor/run.js'

class FakeWorker extends EventEmitter {
  terminated = false

  async terminate(): Promise<number> {
    await Promise.resolve()
    await Promise.resolve()
    this.terminated = true
    return 0
  }
}

function fakeSpawn(): { spawn: BoardTimerSpawn, worker: FakeWorker, started: { entry?: URL, workerData?: Record<string, unknown> } } {
  const worker = new FakeWorker()
  const started: { entry?: URL, workerData?: Record<string, unknown> } = {}
  const spawn: BoardTimerSpawn = (entry, workerData) => {
    started.entry = entry
    started.workerData = workerData
    return worker
  }
  return { spawn, worker, started }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startBoardTimer', () => {
  it('starts the board timer worker with the bus path and the period', () => {
    const { spawn, started } = fakeSpawn()
    const timer = startBoardTimer('/bus/home/bus.db', 1234, spawn)
    expect(started.entry?.pathname.endsWith('/board-page/timer.ts')).toBe(true)
    expect(started.workerData).toEqual({ [BOARD_TIMER_BUS_PATH]: '/bus/home/bus.db', [BOARD_TIMER_PERIOD]: 1234 })
    expect(timer.file.startsWith('/bus/home/')).toBe(true)
    expect(timer.dataFile.startsWith('/bus/home/')).toBe(true)
  })

  it('a board timer worker error is logged with the board timer prefix', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { spawn, worker } = fakeSpawn()
    startBoardTimer('/bus/home/bus.db', 1234, spawn)
    worker.emit('error', new Error('the projection broke\n    at somewhere'))
    expect(logged).toHaveBeenCalledWith(`${BOARD_TIMER_PREFIX}the projection broke`)
  })

  it('stop terminates the board timer worker', async () => {
    const { spawn, worker } = fakeSpawn()
    const timer = startBoardTimer('/bus/home/bus.db', 1234, spawn)
    await timer.stop()
    expect(worker.terminated).toBe(true)
  })
})

describe('superviseUntilEnd', () => {
  it('the supervisor stops the board timer when its loop ends', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    let ticks = 0
    const tick = (): string[] => {
      ticks += 1
      if (ticks > 2)
        throw new Error('the loop ends')
      return ['a tick line']
    }
    let stopped = false
    const board = {
      stop: async (): Promise<void> => {
        await Promise.resolve()
        await Promise.resolve()
        stopped = true
      },
    }
    let closedAfterStop: boolean | undefined
    await expect(superviseUntilEnd(tick, board, () => {
      closedAfterStop = stopped
    }, async () => {})).rejects.toThrow('the loop ends')
    expect(stopped).toBe(true)
    expect(closedAfterStop).toBe(true)
  })
})
