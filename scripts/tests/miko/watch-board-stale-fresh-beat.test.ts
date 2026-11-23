import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOARD_STALE_TICKS, BOARD_TIMER_PERIOD_MS, openBus, recordBoardBeat } from '../../core/db.js'
import { BOARD_STALE, productionDeps } from '../../window/watch.js'

const NOW = Date.parse('2026-11-24T08:00:00.000Z')
const SECOND_MS = 1000
const STALE_AFTER_MS = BOARD_STALE_TICKS * BOARD_TIMER_PERIOD_MS
const HEALTHY_BEAT_AGE_MS = 14_500

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function busWithBoardBeat(at: number): { dir: string, file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'watch-board-beat-'))
  dirs.push(dir)
  const file = path.join(dir, 'bus.db')
  const db = openBus(file)
  try {
    recordBoardBeat(db, new Date(at).toISOString())
  }
  finally {
    db.close()
  }
  return { dir, file }
}

function signalsOf(bus: { dir: string, file: string }): (now: number) => readonly { kind: string }[] {
  const signals = productionDeps(bus.dir, bus.file).signals
  if (signals === undefined)
    throw new Error('productionDeps reads no signals')
  return signals
}

function boardStaleKinds(signals: readonly { kind: string }[]): string[] {
  return signals.map(signal => signal.kind).filter(kind => kind === BOARD_STALE)
}

describe('miko:watch judges the board beat against the time it read it', () => {
  it('a beat fresh when read is not stale when the cached read is judged 29 s later', () => {
    const bus = busWithBoardBeat(NOW - HEALTHY_BEAT_AGE_MS)
    const signals = signalsOf(bus)
    expect(boardStaleKinds(signals(NOW))).toEqual([])
    expect(boardStaleKinds(signals(NOW + 29 * SECOND_MS))).toEqual([])
  })

  it('a board timer silent for more than three ticks still reads as stale', () => {
    const silent = busWithBoardBeat(NOW - STALE_AFTER_MS - 1)
    expect(boardStaleKinds(signalsOf(silent)(NOW))).toEqual([BOARD_STALE])
    const signals = signalsOf(busWithBoardBeat(NOW - HEALTHY_BEAT_AGE_MS))
    expect(boardStaleKinds(signals(NOW))).toEqual([])
    expect(boardStaleKinds(signals(NOW + 30 * SECOND_MS))).toEqual([BOARD_STALE])
  })
})
