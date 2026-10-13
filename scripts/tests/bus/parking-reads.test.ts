import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingLanes } from '../../bus/board.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { busParkingReads } from '../../bus/parking-reads.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('busParkingReads, the parking reads the board page and handoff:write build over a bus', () => {
  it('reads a depends as merged when the bus holds the card closed, so the parking lane takes the card', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-parking-reads-'))
    roots.push(root)
    const bus = path.join(root, 'bus.db')
    const db = openBus(bus)
    try {
      appendEvent(db, { ts: '2026-10-13T00:00:00.000Z', type: 'card.admitted', actor: 'worker:intake:test', cardId: 5, pr: null, head: null, dedupeKey: 'card.admitted:5', payload: {}, legacy: false })
      db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (5, \'closed\', NULL, 1)').run()
    }
    finally {
      db.close()
    }
    const parking = path.join(root, 'parking')
    mkdirSync(path.join(parking, 'lane-1'), { recursive: true })
    writeFileSync(path.join(parking, 'lane-1', '7.md'), 'card: #7 task-7 [implement/ghosts/S/cheap/owner] · depends #5 · blocks —\nbranch: feat/7\ntouches: scripts/7/**\nwho: shift\n\ndo 7\n')
    expect(parkingLanes(busParkingReads(bus), parking).map(lane => lane.choice.chosen.map(task => task.id))).toEqual([['7']])
  })
})
