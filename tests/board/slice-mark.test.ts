import type { BusFacts } from '../../src/commands/board/bus.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { busJson, renderBoard } from '../../scripts/cli/board-page.js'
import { CARD_ADMITTED, SLICE_PARENTS_BACKFILLED } from '../../scripts/core/events.js'
import { busFacts } from '../../src/commands/board/bus.js'
import { screenLines, tallyLine } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'
import { writeBus } from './bus-fixture.js'

const NOW = new Date('2026-11-13T10:00:00.000Z')
const SINCE = '2026-11-13T09:00:00.000Z'
const WHOLE = 20
const FIRST_SLICE = 21
const SECOND_SLICE = 22
const CUT_PARENT = 30
const BACKFILLED_SLICE = 23
const BACKFILLED_PARENT = 40
const OTHER_WHOLE = 24
const FIRST_MARK = `◧ 1/2 · из #${CUT_PARENT}`
const SECOND_MARK = `◧ 2/2 · из #${CUT_PARENT}`
const BACKFILLED_MARK = `◧ 1/2 · из #${BACKFILLED_PARENT}`
const TALLY = '5 карт = 4 задачи'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function card(id: number, name: string, state = 'running'): { id: number, state: string, lane: string, line: string, since: string } {
  return { id, state, lane: 'lane-window', line: `#${id} ${name} [implement/construct/S/cheap/auto] · depends — · blocks —`, since: SINCE }
}

function admitted(id: number, parent: Record<string, number> | null): { ts: string, type: string, card: number, payload: string } {
  return { ts: SINCE, type: CARD_ADMITTED, card: id, payload: JSON.stringify(parent === null ? { text: 'x' } : { text: 'x', parent }) }
}

function readBus<T>(read: (db: DatabaseSync) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-slice-mark-'))
  roots.push(root)
  const file = writeBus(path.join(root, 'bus.db'), {
    cards: [card(WHOLE, 'whole-card'), card(FIRST_SLICE, 'cut-slice-1'), card(SECOND_SLICE, 'cut-slice-2', 'queued'), card(BACKFILLED_SLICE, 'old-slice-1'), card(OTHER_WHOLE, 'another-whole', 'queued')],
    events: [
      admitted(WHOLE, null),
      admitted(FIRST_SLICE, { card: CUT_PARENT, part: 1, of: 2 }),
      admitted(SECOND_SLICE, { card: CUT_PARENT, part: 2, of: 2 }),
      admitted(BACKFILLED_SLICE, null),
      { ts: SINCE, type: SLICE_PARENTS_BACKFILLED, card: null, payload: JSON.stringify({ cards: { [BACKFILLED_SLICE]: { card: BACKFILLED_PARENT, part: 1, of: 2 } }, unread: [] }) },
    ],
  })
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

function page(facts: BusFacts): string {
  return renderBoard({
    version: '0.0.0',
    machine: { load: 0, cores: 1 },
    liveness: 'live',
    modelVersion: null,
    facts,
    windowGauges: null,
    limits: { contextLimit: null, cardContextLine: null, sessionSpend: null, agentSpend: null, warnRatio: null, modelWindows: new Map() },
    details: new Map(),
    decisions: { stale: null, rows: [], at: 0 },
    handoff: { file: 'miko.md', text: null },
    repository: null,
    tickMs: null,
    warnings: [],
  })
}

describe('a slice card is told apart from a whole card on the board', () => {
  it('reads the parent from the admission, and from the one-time transfer for a card cut before the field', () => {
    const parents = readBus(db => busFacts(db, NOW)).cards.map(each => [each.id, each.parent ?? null])
    expect(parents).toEqual([
      [WHOLE, null],
      [FIRST_SLICE, { card: CUT_PARENT, part: 1, of: 2 }],
      [SECOND_SLICE, { card: CUT_PARENT, part: 2, of: 2 }],
      [BACKFILLED_SLICE, { card: BACKFILLED_PARENT, part: 1, of: 2 }],
      [OTHER_WHOLE, null],
    ])
  })

  it('marks each slice in text and counts cards apart from tasks', () => {
    const lines = readBus(db => screenLines(busFacts(db, NOW), PLAIN_LORE))
    const text = lines.join('\n')
    expect(text).toContain(`#${FIRST_SLICE} ${FIRST_MARK}`)
    expect(text).toContain(`#${SECOND_SLICE} ${SECOND_MARK}`)
    expect(text).toContain(`cut-slice-1 [implement/construct/S/cheap/auto] · depends — · blocks — ${FIRST_MARK}`)
    expect(text).toContain(`#${BACKFILLED_SLICE} ${BACKFILLED_MARK}`)
    expect(lines).toContain(TALLY)
    expect(text).toContain(`#${WHOLE} · #${FIRST_SLICE}`)
    expect(lines.filter(line => line.trim().startsWith(`#${WHOLE} `) || line.trim().startsWith(`#${OTHER_WHOLE} `)).map(line => line.includes('◧'))).toEqual([false, false])
  })

  it('marks each slice in --json and counts cards apart from tasks', () => {
    const json = JSON.parse(readBus(db => busJson(db, NOW))) as { tally: { cards: number, tasks: number }, cards: { id: number, mark: string | null, parent: unknown }[] }
    expect(json.tally).toEqual({ cards: 5, tasks: 4 })
    expect(json.cards.map(each => [each.id, each.mark])).toEqual([[WHOLE, null], [FIRST_SLICE, FIRST_MARK], [SECOND_SLICE, SECOND_MARK], [BACKFILLED_SLICE, BACKFILLED_MARK], [OTHER_WHOLE, null]])
    expect(json.cards.find(each => each.id === FIRST_SLICE)!.parent).toEqual({ card: CUT_PARENT, part: 1, of: 2 })
  })

  it('marks each slice on the page and counts cards apart from tasks in its header', () => {
    const html = readBus(db => page(busFacts(db, NOW)))
    expect(html).toContain(`<td class="id">#${FIRST_SLICE} ${FIRST_MARK}</td>`)
    expect(html).toContain(`<td class="id">#${SECOND_SLICE} ${SECOND_MARK}</td>`)
    expect(html).toContain(`<td class="id">#${BACKFILLED_SLICE} ${BACKFILLED_MARK}</td>`)
    expect(html).toContain(`<td class="id">#${WHOLE}</td>`)
    expect(html).toContain(`<td class="id">#${OTHER_WHOLE}</td>`)
    expect(html).toContain(TALLY)
  })

  it('names the counts in Russian plural forms', () => {
    expect([[1, 1], [2, 2], [5, 5], [11, 11], [14, 6], [21, 22]].map(([cards, tasks]) => tallyLine({ cards: cards!, tasks: tasks! }))).toEqual([
      '1 карта = 1 задача',
      '2 карты = 2 задачи',
      '5 карт = 5 задач',
      '11 карт = 11 задач',
      '14 карт = 6 задач',
      '21 карта = 22 задачи',
    ])
  })
})
