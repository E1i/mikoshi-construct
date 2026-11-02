import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openBus } from '../../scripts/core/db.js'
import { closeDrain, openDrain } from '../../scripts/core/lease.js'
import { recordRestarted } from '../../scripts/supervisor/supervisor.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { drainsAt } from '../../src/commands/board/drain.js'
import { printBoard, readBoard } from '../../src/commands/board/index.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'

const NOW = new Date('2026-11-03T16:40:00.000Z')
const OPENED = '2026-11-03T16:29:48.000Z'
const UNTIL = '2026-11-03T16:59:48.000Z'
const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)

function busWith(seed: (db: ReturnType<typeof openBus>) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-board-drain-'))
  const file = path.join(dir, 'bus.db')
  const db = openBus(file)
  seed(db)
  db.close()
  return file
}

function boardLines(file: string): string[] {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true }), text => lines.push(text.replace(/\n$/, '')))
  printBoard(ui, readBoard(path.dirname(file), { all: false, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW, bus: busReaderAt(file, () => NOW) }))
  return lines
}

describe('the board drain reader', () => {
  it('the board shows an open drain with its sha and until', () => {
    const file = busWith(db => openDrain(db, OPENED, NEW_MAIN, UNTIL, 'answer', OLD_MAIN))

    expect(drainsAt(file, NOW)).toEqual([{ node: 'answer', sha: NEW_MAIN, from: OLD_MAIN, until: UNTIL }])
    expect(boardLines(file)).toContain(`drain \u00B7 answer \u00B7 \u2014 \u00B7 aaaaaaa \u2192 bbbbbbb until ${UNTIL}`)
  })

  it('a closed drain, a lapsed one and one from before the last restart are not shown', () => {
    const file = busWith((db) => {
      openDrain(db, '2026-11-03T15:00:00.000Z', NEW_MAIN, UNTIL, 'merge', OLD_MAIN)
      recordRestarted(db, '2026-11-03T15:10:00.000Z', NEW_MAIN)
      openDrain(db, OPENED, NEW_MAIN, UNTIL, 'answer', OLD_MAIN)
      closeDrain(db, '2026-11-03T16:35:00.000Z', NEW_MAIN, 'answer')
      openDrain(db, OPENED, NEW_MAIN, '2026-11-03T16:39:00.000Z', 'close', OLD_MAIN)
    })

    expect(drainsAt(file, NOW)).toEqual([])
    expect(boardLines(file).join('\n')).not.toContain('drain \u00B7')
  })

  it('an unreadable bus shows no drain rather than failing the board', () => {
    expect(drainsAt(path.join(tmpdir(), 'no-such-bus', 'bus.db'), NOW)).toEqual([])
  })
})
