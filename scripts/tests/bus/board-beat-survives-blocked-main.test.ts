import type { BoardTimerSpawn } from '../../cli/board-page.js'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { BOARD_STALE_TICKS, BOARD_TIMER_PERIOD_MS, lastBoardBeat, openBus } from '../../core/db.js'
import { startBoardThread } from '../../supervisor/run.js'
import { boardStaleOf } from '../../window/watch.js'

const TEST_TICK_MS = 500
const STALE_AFTER_MS = BOARD_STALE_TICKS * BOARD_TIMER_PERIOD_MS
const BLOCKED_MS = STALE_AFTER_MS + 2 * TEST_TICK_MS
const PARK_MS = 100
const TEST_TIMEOUT_MS = 180_000
const SOURCE_LOADER = ['--import', 'tsx']

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function sourceWorker(): { spawn: BoardTimerSpawn, firstProjection: Promise<unknown> } {
  let projected: (line: unknown) => void = () => {}
  const firstProjection = new Promise((resolve) => {
    projected = resolve
  })
  const spawn: BoardTimerSpawn = (entry, workerData) => {
    const worker = new Worker(entry, { workerData, execArgv: SOURCE_LOADER, stdout: true })
    worker.stdout.once('data', projected)
    return worker
  }
  return { spawn, firstProjection }
}

function blockThisThreadFor(ms: number): void {
  const parked = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const until = Date.now() + ms
  while (Date.now() < until)
    Atomics.wait(parked, 0, 0, Math.min(PARK_MS, until - Date.now()))
}

describe('the board beat with the bus:run thread blocked', () => {
  it('the worker keeps recording its own beat after each page write while the parent thread is blocked past the stale line', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'board-beat-blocked-main-'))
    roots.push(root)
    const busPath = path.join(root, 'bus.db')
    openBus(busPath).close()
    const db = new DatabaseSync(busPath)
    const worker = sourceWorker()
    const board = startBoardThread(db, busPath, TEST_TICK_MS, worker.spawn)
    let blockedAt: number
    let now: number
    let writtenMs: number
    let beat: string | undefined
    try {
      await worker.firstProjection
      expect(lastBoardBeat(db)).toBeDefined()
      blockedAt = Date.now()
      blockThisThreadFor(BLOCKED_MS)
      now = Date.now()
      writtenMs = statSync(board.dataFile).mtimeMs
      beat = lastBoardBeat(db)
    }
    finally {
      await board.stop()
      db.close()
    }
    expect(writtenMs).toBeGreaterThan(blockedAt + STALE_AFTER_MS)
    expect(beat).toBeDefined()
    expect(Math.abs(Date.parse(beat!) - writtenMs)).toBeLessThanOrEqual(TEST_TICK_MS)
    expect(boardStaleOf(beat, now)).toEqual([])
  }, TEST_TIMEOUT_MS)
})
