import type { CardEvent, IntakeOptions, IntakeResult } from '../../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUS_CONTRACT } from '../../scripts/core/bus-adapter.js'
import { appendCardEvent } from '../../scripts/core/card-bodies.js'
import { openBus } from '../../scripts/core/db.js'
import { CARD_ADMITTED } from '../../scripts/core/events.js'
import { runIntake } from '../../src/commands/intake/index.js'
import { parentsFromCardLines } from '../../src/commands/intake/slice.js'

const TAKEN_THROUGH = '12'
const PARENT = 13
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { repo: string, parking: string, draft: string, bus: CardEvent[] }

function world(touches: readonly string[], fields: Record<string, unknown> = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), 'slice-parent-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const entry of touches) {
    mkdirSync(path.dirname(path.join(repo, entry)), { recursive: true })
    writeFileSync(path.join(repo, entry), '')
  }
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards: [{ name: 'cut-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', touches, task: 'Cut the card.', witnesses: ['`pnpm run quality` is green'], ...fields }] }))
  return { repo, parking: path.join(root, 'parking'), draft, bus: [] }
}

function intake(w: World, options: Partial<IntakeOptions> = {}): IntakeResult {
  return runIntake({ draft: w.draft, taken: '-', parking: w.parking, dir: w.repo, dryRun: false, autoConfirm: false, readStdin: () => TAKEN_THROUGH, events: event => w.bus.push(event), ...options })
}

function parentsAdmitted(bus: readonly CardEvent[]): [number, unknown][] {
  return bus.filter(event => event.type === CARD_ADMITTED).map(event => [event.cardId, event.payload.parent ?? null])
}

describe('the Shredder writes the parent on each slice it cuts', () => {
  it('cutting a card into two slices writes the parent number and k of n on both slices\' card.admitted', () => {
    const w = world(['scripts/core/queue.ts', 'scripts/core/inbox.ts'])
    writeFileSync(path.join(w.repo, 'scripts/core/queue.ts'), 'import { inboxOf } from \'./inbox.js\'\n')
    const held = intake(w)
    expect(held.status).toBe('awaiting')
    const confirmed = intake(w, { confirm: held.status === 'awaiting' ? held.token : '' })
    expect(confirmed.status).toBe('written')
    expect(parentsAdmitted(w.bus)).toEqual([
      [13, { card: PARENT, part: 1, of: 2 }],
      [14, { card: PARENT, part: 2, of: 2 }],
    ])
  })

  it('derives a slice\'s parent from the card lines: a stub named after the base, else the lowest sibling', () => {
    const lines = [
      { card: 50, line: '#50 stub-card [implement/runner/S/cheap/owner]' },
      { card: 51, line: '#51 stub-card-slice-1 [implement/runner/S/cheap/owner]' },
      { card: 61, line: '#61 bare-slice-2 [implement/runner/S/cheap/owner]' },
      { card: 63, line: '#63 bare-slice-3 [implement/runner/S/cheap/owner]' },
    ]
    expect(parentsFromCardLines(lines, lines)).toEqual({
      cards: { 51: { card: 50, part: 1, of: 1 }, 61: { card: 61, part: 2, of: 3 }, 63: { card: 61, part: 3, of: 3 } },
      unread: [],
    })
  })

  it('a slice name two cards share is read two ways and gets no parent', () => {
    const lines = [
      { card: 90, line: '#90 twice-slice-1 [implement/runner/S/cheap/owner]' },
      { card: 91, line: '#91 twice-slice-1 [implement/runner/S/cheap/owner]' },
    ]
    expect(parentsFromCardLines([lines[1]!], lines)).toEqual({ cards: {}, unread: [91] })
  })

  it('admitting a slice whose name and part another card carries writes no parent and says so', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'slice-parent-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const said: string[] = []
    try {
      for (const id of [90, 91])
        appendCardEvent(BUS_CONTRACT, db, 'worker:intake:test', { type: CARD_ADMITTED, cardId: id, ts: '2026-11-17T09:00:00.000Z', dedupeKey: `${CARD_ADMITTED}:${id}`, payload: { card: `#${id} twice-slice-1 [implement/runner/S/cheap/owner]` } }, line => said.push(line))
      const parents = (db.prepare('SELECT card_id, payload FROM events WHERE type = ? ORDER BY id').all(CARD_ADMITTED) as { card_id: number, payload: string }[])
        .map(row => [Number(row.card_id), (JSON.parse(row.payload) as Record<string, unknown>).parent ?? null])
      expect(parents).toEqual([[90, { card: 90, part: 1, of: 1 }], [91, null]])
      expect(said).toEqual(['#91: another card carries the same slice name and part; admitted without a parent'])
    }
    finally {
      db.close()
    }
  })

  it('re-admitting a slice the bus already holds writes its parent again, not counting its own earlier line as a sibling', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'slice-parent-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const said: string[] = []
    try {
      const line = (id: number, part: number): string => `#${id} again-slice-${part} [implement/runner/S/cheap/owner]`
      appendCardEvent(BUS_CONTRACT, db, 'worker:intake:test', { type: CARD_ADMITTED, cardId: 90, ts: '2026-11-17T09:00:00.000Z', dedupeKey: `${CARD_ADMITTED}:90`, payload: { card: line(90, 1) } }, entry => said.push(entry))
      appendCardEvent(BUS_CONTRACT, db, 'worker:intake:test', { type: CARD_ADMITTED, cardId: 91, ts: '2026-11-17T09:01:00.000Z', dedupeKey: `${CARD_ADMITTED}:91`, payload: { card: line(91, 2) } }, entry => said.push(entry))
      appendCardEvent(BUS_CONTRACT, db, 'worker:intake:test', { type: CARD_ADMITTED, cardId: 91, ts: '2026-11-17T09:02:00.000Z', dedupeKey: `${CARD_ADMITTED}:91:amend`, payload: { card: line(91, 2) } }, entry => said.push(entry))
      const parents = (db.prepare('SELECT card_id, payload FROM events WHERE type = ? ORDER BY id').all(CARD_ADMITTED) as { card_id: number, payload: string }[])
        .map(row => [Number(row.card_id), (JSON.parse(row.payload) as Record<string, unknown>).parent ?? null])
      expect(parents).toEqual([
        [90, { card: 90, part: 1, of: 1 }],
        [91, { card: 90, part: 2, of: 2 }],
        [91, { card: 90, part: 2, of: 2 }],
      ])
      expect(said).toEqual([])
    }
    finally {
      db.close()
    }
  })

  it('a parent the cut already wrote stands over the one the card lines would derive', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'slice-parent-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    try {
      const cut = { card: 94, part: 1, of: 2 }
      appendCardEvent(BUS_CONTRACT, db, 'worker:intake:test', { type: CARD_ADMITTED, cardId: 95, ts: '2026-11-17T09:00:00.000Z', dedupeKey: `${CARD_ADMITTED}:95`, payload: { card: '#95 cut-slice-1 [implement/runner/S/cheap/owner]', parent: cut } }, () => {})
      const row = db.prepare('SELECT payload FROM events WHERE type = ? AND card_id = ?').get(CARD_ADMITTED, 95) as { payload: string }
      expect((JSON.parse(row.payload) as Record<string, unknown>).parent).toEqual(cut)
    }
    finally {
      db.close()
    }
  })

  it('a card admitted whole carries no parent', () => {
    const w = world(['src/a.ts'])
    expect(intake(w, { autoConfirm: true }).status).toBe('written')
    expect(parentsAdmitted(w.bus)).toEqual([[13, null]])
  })
})
