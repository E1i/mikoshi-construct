import type { GateRun } from '../../scripts/ci/gate-runs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { modeOfArgs, recordGateRun } from '../../scripts/ci/gate-runs.js'
import { ciArgs } from '../../scripts/ci/prepush.js'
import { openBus } from '../../scripts/core/db.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { compareGateRuns, gateRunsAt, gateRunsLines, SMALL_SAMPLE } from '../../src/commands/board/gate-runs.js'
import { printBoard, readBoard } from '../../src/commands/board/index.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'

const NOW = new Date('2026-11-15T12:00:00.000Z')
const ROUND = 'a'.repeat(40)
const OTHER_ROUND = 'b'.repeat(40)
const LAYERED_ARGS = ciArgs({ kind: 'layers', layers: ['board'], tests: ['tests/board/drain.test.ts'] })
const FULL_ARGS = ciArgs({ kind: 'full', why: 'contract/module-files.json belongs to no layer of the check catalog' })

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function emptyBus(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-board-gate-runs-'))
  roots.push(dir)
  const file = path.join(dir, 'bus.db')
  openBus(file).close()
  return file
}

function at(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()
}

function run(source: GateRun['source'], args: readonly string[], seconds: number, round: string = ROUND): GateRun {
  return { source, mode: modeOfArgs(args), reason: 'the layers the change reaches', seconds, round, card: 1938, moduleFiles: true, tests: 1 }
}

function record(file: string, runs: readonly GateRun[]): void {
  runs.forEach((each, index) => recordGateRun(each, at(runs.length - index), file))
}

function boardLines(file: string): string[] {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true }), text => lines.push(text.replace(/\n$/, '')))
  printBoard(ui, readBoard(path.dirname(file), { all: false, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW, bus: busReaderAt(file, () => NOW) }))
  return lines
}

describe('the board gate-runs lines', () => {
  it('a full run recorded for a path with no layer raises the full share on the board', () => {
    const layered = emptyBus()
    record(layered, [run('gate', LAYERED_ARGS, 40), run('prepush', LAYERED_ARGS, 30)])
    const mutated = emptyBus()
    record(mutated, [run('gate', LAYERED_ARGS, 40), run('prepush', LAYERED_ARGS, 30), run('gate', FULL_ARGS, 2068)])

    expect(modeOfArgs(FULL_ARGS)).toBe('full')
    const before = gateRunsAt(layered, NOW)!
    const after = gateRunsAt(mutated, NOW)!
    expect(before.sources.gate).toEqual({ runs: 1, fullShare: 0, medianSeconds: 40, small: true })
    expect(after.sources.gate).toEqual({ runs: 2, fullShare: 0.5, medianSeconds: 1054, small: true })
    expect(after.sources.prepush).toEqual(before.sources.prepush)
    expect(after.rounds).toEqual({ rounds: 1, medianSeconds: 2138, maxSeconds: 2138 })
    expect(boardLines(mutated)).toEqual(expect.arrayContaining([expect.stringMatching(/gate-runs · gate.*2 runs in 24 h · full 50% · median 1054 s · small sample/)]))
  })

  it('each run counts once, three full runs in one round count three', () => {
    const file = emptyBus()
    record(file, [run('gate', FULL_ARGS, 100), run('gate', FULL_ARGS, 100), run('gate', FULL_ARGS, 100), run('gate', LAYERED_ARGS, 10, OTHER_ROUND)])
    const read = gateRunsAt(file, NOW)!
    expect(read.sources.gate.runs).toBe(4)
    expect(read.sources.gate.fullShare).toBe(0.75)
    expect(read.sources.prepush.runs).toBe(0)
    expect(read.rounds).toEqual({ rounds: 2, medianSeconds: 155, maxSeconds: 300 })
  })

  it('no gate run in the last day shows no lines', () => {
    expect(gateRunsAt(emptyBus(), NOW)).toBeNull()
    const lore = createUi(resolveTheme({ plain: true }), () => {}).lore
    expect(gateRunsLines((role, task, detail) => lore.boardServiceLine(role, task, undefined, detail), null)).toEqual([])
  })

  it('a speed-up counts as confirmed only when neither window is a small sample', () => {
    const cut = new Date(NOW.getTime() - 12 * 60 * 60_000)
    const rowsOf = (count: number, seconds: number, hoursFromCut: number) => Array.from({ length: count }, (_, index) => ({ at: new Date(cut.getTime() + hoursFromCut * 60 * 60_000 + index * 1000).toISOString(), source: 'gate' as const, full: false, seconds, round: `${hoursFromCut}-${index}` }))

    const small = compareGateRuns([...rowsOf(3, 500, -1), ...rowsOf(3, 100, 1)], cut)
    expect(small.gate.before.small).toBe(true)
    expect(small.gate.confirmedSpeedup).toBe(false)

    const large = compareGateRuns([...rowsOf(SMALL_SAMPLE, 500, -1), ...rowsOf(SMALL_SAMPLE, 100, 1)], cut)
    expect(large.gate).toMatchObject({ before: { runs: SMALL_SAMPLE, medianSeconds: 500, small: false }, after: { runs: SMALL_SAMPLE, medianSeconds: 100, small: false }, confirmedSpeedup: true })
    expect(large.prepush).toMatchObject({ before: { runs: 0, small: true }, confirmedSpeedup: false })
  })
})
