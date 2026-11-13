import type { BusFacts } from '../../src/commands/board/bus.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { busJson, renderBoard } from '../../scripts/cli/board-page.js'
import { CARD_ANSWERED, MERGE_DONE, OWNER_WAIT_OPENED } from '../../scripts/core/events.js'
import { busFacts } from '../../src/commands/board/bus.js'
import { screenLines } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'
import { writeBus } from './bus-fixture.js'

const REDUCED_AT = '2026-11-12T09:54:30.000Z'
const MERGED_AT = '2026-11-12T09:56:10.000Z'
const ANSWERED_AT = '2026-11-12T09:56:54.000Z'
const NOW = new Date('2026-11-12T09:57:00.000Z')
const CARD = 1501
const WAIT = 'Q7'
const WAIT_TEXT = 'which path for #1501?'
const WAITS_MARK = /^owner_waits shows the last reduced list, behind by 1 events and 100 s: reduced through event \d+, behind merge\.done \d+$/
const CARDS_MARK = /^cards shows the last reduced list, behind by 2 events and 144 s: reduced through event \d+, behind card\.answered \d+$/
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busBehind(current: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-stale-board-'))
  roots.push(root)
  const file = writeBus(path.join(root, 'bus.db'), {
    cards: [{ id: CARD, state: 'running', lane: 'lane-1', line: `card: #${CARD} slice`, since: REDUCED_AT }],
    events: [{ ts: REDUCED_AT, type: OWNER_WAIT_OPENED, card: CARD, payload: JSON.stringify({ id: WAIT }) }],
  })
  const db = new DatabaseSync(file)
  try {
    const opened = Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
    db.prepare('INSERT INTO owner_waits (id, need, text, command, card_id, pr, state, opened_at, event_id) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?)').run(WAIT, 'decision', WAIT_TEXT, CARD, 'open', REDUCED_AT, opened)
    const append = db.prepare('INSERT INTO events (ts, type, card_id, payload) VALUES (?, ?, ?, ?)')
    append.run(MERGED_AT, MERGE_DONE, CARD + 1, '{}')
    append.run(ANSWERED_AT, CARD_ANSWERED, CARD, '{}')
    if (current)
      db.exec('UPDATE projection_watermarks SET through_event_id = (SELECT max(id) FROM events)')
  }
  finally {
    db.close()
  }
  return file
}

function readBehind<T>(read: (db: DatabaseSync) => T, current = false): T {
  const db = new DatabaseSync(busBehind(current), { readOnly: true })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

describe('a board whose projections are behind their events', () => {
  it('lists the last reduced waits and cards and marks each list behind by events and seconds', () => {
    const facts = readBehind(db => busFacts(db, NOW))
    expect(facts.waits.map(wait => wait.id)).toEqual([WAIT])
    expect(facts.cards.map(card => card.id)).toEqual([CARD])
    expect(facts.waitsStale).toMatch(WAITS_MARK)
    expect(facts.cardsStale).toMatch(CARDS_MARK)
  })

  it('renders the rows and the marks in text', () => {
    const text = readBehind(db => screenLines(busFacts(db, NOW), PLAIN_LORE)).join('\n')
    expect(text).toContain(WAIT_TEXT)
    expect(text).toContain(`#${CARD}`)
    expect(text).toMatch(/owner_waits shows the last reduced list, behind by 1 events and 100 s/)
    expect(text).toMatch(/cards shows the last reduced list, behind by 2 events and 144 s/)
  })

  it('renders the rows and the marks in --json', () => {
    const json = JSON.parse(readBehind(db => busJson(db, NOW))) as { waits: { id: string }[], cards: { id: number }[], waitsStale: string, cardsStale: string }
    expect(json.waits.map(wait => wait.id)).toEqual([WAIT])
    expect(json.cards.map(card => card.id)).toEqual([CARD])
    expect(json.waitsStale).toMatch(WAITS_MARK)
    expect(json.cardsStale).toMatch(CARDS_MARK)
  })

  it('renders the rows and the marks on the page', () => {
    const facts: BusFacts = readBehind(db => busFacts(db, NOW))
    const html = renderBoard({
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
    expect(html).toContain(WAIT_TEXT)
    expect(html).toContain(`#${CARD}`)
    expect(html).toContain(facts.waitsStale!)
    expect(html).toContain(facts.cardsStale!)
  })

  it('a reading that is current carries no mark', () => {
    const facts = readBehind(db => busFacts(db, NOW), true)
    expect([facts.waits.map(wait => wait.id), facts.cards.map(card => card.id), facts.waitsStale, facts.cardsStale]).toEqual([[WAIT], [CARD], undefined, undefined])
  })
})
