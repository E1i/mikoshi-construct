import type { BoardTimerSpawn } from '../../cli/board-page.js'
import type { BoardThreadDown } from '../../supervisor/run.js'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TIMER_BUS_PATH, BOARD_TIMER_PERIOD, BOARD_TIMER_PREFIX, startBoardTimer } from '../../cli/board-page.js'
import { BOARD_RESTART_CAP_MS, BOARD_THREAD, boardThreadEndedLine, keepBoardThread, restartDelayMs, superviseUntilEnd } from '../../supervisor/run.js'

class FakeWorker extends EventEmitter {
  terminated = false

  async terminate(): Promise<number> {
    await Promise.resolve()
    await Promise.resolve()
    this.terminated = true
    return 0
  }
}

function fakeSpawn(): { spawn: BoardTimerSpawn, readonly worker: FakeWorker, workers: FakeWorker[], started: { entry?: URL, workerData?: Record<string, unknown> } } {
  const workers: FakeWorker[] = []
  const started: { entry?: URL, workerData?: Record<string, unknown> } = {}
  const spawn: BoardTimerSpawn = (entry, workerData) => {
    started.entry = entry
    started.workerData = workerData
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  }
  return { spawn, get worker() {
    return workers.at(-1)!
  }, workers, started }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startBoardTimer and the board thread bus:run keeps', () => {
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
    const fake = fakeSpawn()
    startBoardTimer('/bus/home/bus.db', 1234, fake.spawn)
    fake.worker.emit('error', new Error('the projection broke\n    at somewhere'))
    expect(logged).toHaveBeenCalledWith(`${BOARD_TIMER_PREFIX}the projection broke`)
  })

  it('stop terminates the board timer worker', async () => {
    const fake = fakeSpawn()
    const timer = startBoardTimer('/bus/home/bus.db', 1234, fake.spawn)
    await timer.stop()
    expect(fake.worker.terminated).toBe(true)
  })

  it('a thread that ends reports worker.down with its cause, is logged and is started again after one period', async () => {
    vi.useFakeTimers()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeSpawn()
    const downs: BoardThreadDown[] = []
    let now = 0
    const timer = keepBoardThread('/bus/home/bus.db', 1000, fake.spawn, down => downs.push(down), () => now)
    fake.worker.emit('error', new Error('Cannot find module \'timer.ts\'\n    at somewhere'))
    fake.worker.emit('exit', 1)
    expect(downs).toEqual([{ worker: BOARD_THREAD, cause: 'Cannot find module \'timer.ts\'', failures: 1, nextAttemptAt: new Date(1000) }])
    expect(logged).toHaveBeenCalledWith(boardThreadEndedLine('Cannot find module \'timer.ts\'', 1000))
    expect(fake.workers).toHaveLength(1)
    now = 1000
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.workers).toHaveLength(2)
    fake.worker.emit('exit', 1)
    expect(downs.at(-1)).toMatchObject({ cause: 'exit code 1', failures: 2, nextAttemptAt: new Date(3000) })
    await timer.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.workers).toHaveLength(2)
  })

  it('a thread that ran for two periods before it ended counts its failures from one again', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeSpawn()
    const downs: BoardThreadDown[] = []
    let now = 0
    keepBoardThread('/bus/home/bus.db', 1000, fake.spawn, down => downs.push(down), () => now)
    fake.worker.emit('exit', 1)
    now = 1000
    vi.advanceTimersByTime(1000)
    now = 5000
    fake.worker.emit('exit', 1)
    expect(downs.map(down => down.failures)).toEqual([1, 1])
  })

  it('a failed record of worker.down is logged and the thread is started again all the same', () => {
    vi.useFakeTimers()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = fakeSpawn()
    keepBoardThread('/bus/home/bus.db', 1000, fake.spawn, () => {
      throw new Error('database is locked')
    }, () => 0)
    fake.worker.emit('exit', 1)
    expect(logged.mock.calls.flat().some(line => String(line).includes('recording worker.down') && String(line).includes('database is locked'))).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(fake.workers).toHaveLength(2)
  })

  it('an exit after stop is no failure', async () => {
    const fake = fakeSpawn()
    const downs: BoardThreadDown[] = []
    const timer = keepBoardThread('/bus/home/bus.db', 1000, fake.spawn, down => downs.push(down))
    await timer.stop()
    fake.worker.emit('exit', 1)
    expect(downs).toEqual([])
  })

  it('the restart delay doubles per failure and stops at its cap', () => {
    expect([1, 2, 3].map(failures => restartDelayMs(10_000, failures))).toEqual([10_000, 20_000, 40_000])
    expect(restartDelayMs(10_000, 20)).toBe(BOARD_RESTART_CAP_MS)
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
