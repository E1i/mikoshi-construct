import type { BusSeed } from './bus-fixture.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { printBoard, readBoard } from '../../src/commands/board/index.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'
import { writeBus } from './bus-fixture.js'

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/bus-2026-10-19.json', import.meta.url), 'utf8')) as BusSeed & { at: string }
const SCREEN_LINES = 60
const NOT_IN_FLOW = ['#1068', '#170', '#951']

function board(all = false): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-board-snapshot-'))
  const file = writeBus(path.join(dir, 'bus.db'), SNAPSHOT)
  const now = new Date(SNAPSHOT.at)
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true }), text => lines.push(text.replace(/\n$/, '')))
  printBoard(ui, readBoard(dir, { all, staleHours: 4, prs: undefined, readStdin: () => '', now, bus: busReaderAt(file, () => now), version: '0.44.0', mode: undefined }))
  return lines
}

function flowOf(lines: string[]): string[] {
  return lines.slice(lines.indexOf('Flow'), lines.indexOf('Backlog'))
}

describe('the board on the bus of 2026-10-19', () => {
  it('--plain prints at most 60 lines', () => {
    expect(board().length).toBeLessThanOrEqual(SCREEN_LINES)
  })

  // eslint-disable-next-line test/prefer-lowercase-title
  it('Flow shows none of #1068, #170, #951', () => {
    const flow = flowOf(board()).join('\n')
    expect(flow).toContain('#858')
    for (const card of NOT_IN_FLOW)
      expect(flow).not.toContain(card)
  })

  // eslint-disable-next-line test/prefer-lowercase-title
  it('Services shows the window', () => {
    const lines = board()
    expect(lines.slice(lines.indexOf('Services'))).toContain('window · miko · — · owner · CONTINUE')
  })
})
