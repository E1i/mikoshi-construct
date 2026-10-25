import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { busCardBodies, busParkedDepends, cardBodies } from '../../intake/parking-reads.js'
import { reduce } from '../../core/reducer.js'
import { CARD_ADMITTED, CARD_DROPPED } from '../../core/events.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, depends: number[]): string {
  return `card: #${id} task-${id} [implement/ghosts/S/cheap/owner] · depends ${depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')} · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\nwho: shift\n\ndo ${id}\n`
}

function busWith(cards: { id: number, depends: number[] }[], dropped: number[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-parking-reads-'))
  roots.push(root)
  const bus = path.join(root, 'bus.db')
  const db = openBus(bus)
  try {
    for (const { id, depends } of cards) {
      const text = cardText(id, depends)
      appendEvent(db, { ts: '2026-10-13T00:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:test', cardId: id, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${id}`, payload: { lane: 'lane-1', depends, text, textSha: textSha(text) }, legacy: false })
    }
    for (const id of dropped)
      appendEvent(db, { ts: '2026-10-13T00:01:00.000Z', type: CARD_DROPPED, actor: 'worker:intake:test', cardId: id, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${id}`, payload: { lane: 'dropped' }, legacy: false })
    reduce(db)
  }
  finally {
    db.close()
  }
  return bus
}

describe('the parking reads over the bus projection card_bodies', () => {
  it('reads every admitted body and the depends of the cards neither closed nor dropped', () => {
    const bus = busWith([{ id: 5, depends: [] }, { id: 7, depends: [5] }, { id: 9, depends: [] }], [9])
    const db = openBus(bus)
    try {
      expect(cardBodies(db).map(body => body.card)).toEqual([5, 7, 9])
    }
    finally {
      db.close()
    }
    expect(busCardBodies(bus)(7)).toBe(cardText(7, [5]))
    expect([...busParkedDepends(bus)]).toEqual([[5, []], [7, [5]]])
  })

  it('reads nothing and creates no file when there is no bus', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-parking-reads-'))
    roots.push(root)
    expect(busCardBodies(path.join(root, 'bus.db'))(7)).toBeNull()
    expect(busParkedDepends(path.join(root, 'bus.db')).size).toBe(0)
  })
})
