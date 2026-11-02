import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../scripts/core/db.js'
import { BUS_HEAL_HELD, BUS_HEALED } from '../../scripts/core/events.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { healAt } from '../../src/commands/board/heal.js'
import { printBoard, readBoard } from '../../src/commands/board/index.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'

const NOW = new Date('2026-11-03T16:40:00.000Z')
const HEALED_AT = '2026-11-03T16:00:00.000Z'
const BACKUP = '/backups/2026-11-03T16-00-00-000Z'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busWith(events: { type: string, ts: string, payload: Record<string, unknown> }[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-board-heal-'))
  roots.push(dir)
  const file = path.join(dir, 'bus.db')
  const db = openBus(file)
  for (const event of events)
    appendEvent(db, { ts: event.ts, type: event.type, actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: `${event.type}:${event.ts}`, payload: event.payload, legacy: false })
  db.close()
  return file
}

function boardLines(file: string): string[] {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true }), text => lines.push(text.replace(/\n$/, '')))
  printBoard(ui, readBoard(path.dirname(file), { all: false, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW, bus: busReaderAt(file, () => NOW) }))
  return lines
}

describe('the board heal line', () => {
  it('a healed bus shows what was broken and what was done', () => {
    const file = busWith([{ type: BUS_HEALED, ts: HEALED_AT, payload: { backup: BACKUP, broken: ['row 3 missing from index events_by_type'], steps: ['REINDEX events', 'VACUUM'] } }])

    expect(healAt(file, NOW)).toEqual({ kind: 'healed', at: HEALED_AT, backup: BACKUP, done: '1 broken · REINDEX events → VACUUM' })
    expect(boardLines(file)).toContain(`heal · healed · ${BACKUP} · ${HEALED_AT} · 1 broken · REINDEX events → VACUUM`)
  })

  it('a held heal stays on the board, an old healed one leaves it', () => {
    const held = busWith([{ type: BUS_HEAL_HELD, ts: '2026-11-01T10:00:00.000Z', payload: { failure: 'pragma integrity_check is not ok', backup: BACKUP } }])
    const old = busWith([{ type: BUS_HEALED, ts: '2026-11-01T10:00:00.000Z', payload: { backup: BACKUP, broken: [], steps: [] } }])

    expect(healAt(held, NOW)).toMatchObject({ kind: 'held', done: 'pragma integrity_check is not ok' })
    expect(healAt(old, NOW)).toBeNull()
    expect(boardLines(old).some(line => line.startsWith('heal'))).toBe(false)
  })
})
